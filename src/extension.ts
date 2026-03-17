import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as https from "https";
import * as http from "http";

// ── Types ─────────────────────────────────────────────────────
interface JobInfo {
  model: string;
  duration: string;
  turns: number;
  errorCode?: string; // HTTP status ("429", "401") or system code ("ETIMEDOUT")
}

// ── Globals ───────────────────────────────────────────────────
let statusBarItem: vscode.StatusBarItem;
let pollTimer: NodeJS.Timeout | undefined;
let currentLogPath = "";
let lastByteOffset = 0;
let pendingCcreqLine = "";
let pendingTurnCount = 0;
let pendingJobStartMs = 0;
let pendingPromptFiltered = false; // set when promptFiltered fires before the associated editAgent failed
let isWatching = false;
let windowExtHostLogDir = ""; // set from context.logUri — unique per VS Code window
let extensionContext: vscode.ExtensionContext;

// ── Shared state (cross-window IPC) ──────────────────────────
const SHARED_STATE_FILE = "watchState.json";
const NOTIF_DEDUP_MS = 5000;

interface SharedStateData {
  isWatching: boolean;
  lastNotifKey?: string;
  lastNotifTs?: number;
}

function getSharedStatePath(): string {
  return path.join(extensionContext.globalStorageUri.fsPath, SHARED_STATE_FILE);
}

function readSharedStateData(): SharedStateData {
  try {
    return JSON.parse(fs.readFileSync(getSharedStatePath(), "utf8"));
  } catch {
    return { isWatching: false };
  }
}

function writeSharedStateData(data: SharedStateData): void {
  try {
    fs.mkdirSync(extensionContext.globalStorageUri.fsPath, { recursive: true });
    fs.writeFileSync(getSharedStatePath(), JSON.stringify(data), "utf8");
  } catch {
    // ignore write errors
  }
}

function readSharedIsWatching(): boolean {
  return readSharedStateData().isWatching === true;
}

function writeSharedIsWatching(value: boolean): void {
  const data = readSharedStateData();
  writeSharedStateData({ ...data, isWatching: value });
}

// ── Activation ────────────────────────────────────────────────
export async function activate(context: vscode.ExtensionContext) {
  extensionContext = context;

  // Per-window log directory: parent of this extension's log folder is the shared exthost dir
  windowExtHostLogDir = path.dirname(context.logUri.fsPath);

  // Ensure global storage directory exists (needed for shared state file)
  fs.mkdirSync(context.globalStorageUri.fsPath, { recursive: true });

  // Status bar
  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  statusBarItem.command = "copilotNtfy.startWatching";
  setStatusIdle();
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand("copilotNtfy.startWatching", startWatching),
    vscode.commands.registerCommand("copilotNtfy.stopWatching", stopWatching),
    vscode.commands.registerCommand("copilotNtfy.setTopic", promptForTopic),
    vscode.commands.registerCommand("copilotNtfy.openSettings", () =>
      vscode.commands.executeCommand("workbench.action.openSettings", "@ext:MrCarrotLabs.copilot-ntfy")
    )
  );

  // ── Cross-window sync ──────────────────────────────────────
  // If another window is already watching, start polling immediately
  if (readSharedIsWatching()) {
    _startPolling();
  } else {
    // Auto-start based on setting
    const autoStart = getConfig().get<boolean>("autoStart", true);
    const topic = getTopic();
    if (autoStart && topic) {
      await startWatching();
    } else if (autoStart && !topic) {
      const newTopic = await promptForTopic();
      if (newTopic) {
        await startWatching();
      }
    }
  }

  // Watch the shared state file so this window reacts when another window
  // starts or stops watching (fs.watchFile uses polling — reliable cross-process)
  fs.watchFile(getSharedStatePath(), { interval: 500 }, () => {
    syncFromSharedState();
  });
}

export function deactivate() {
  // Stop watching the shared state file — do not change it;
  // other windows should continue running unaffected.
  try { fs.unwatchFile(getSharedStatePath()); } catch { /* ignore */ }
  _stopPolling();
}

// ── Status bar helpers ────────────────────────────────────────
function setStatusWatching() {
  statusBarItem.text = "Copilot Ntfy: $(eye)";
  const md = new vscode.MarkdownString(
    "**Copilot Ntfy** is active\n\n" +
    "[Stop watching](command:copilotNtfy.stopWatching) · " +
    "[Open settings](command:copilotNtfy.openSettings)"
  );
  md.isTrusted = true;
  statusBarItem.tooltip = md;
  statusBarItem.command = "copilotNtfy.stopWatching";
  statusBarItem.backgroundColor = undefined;
}

function setStatusIdle() {
  statusBarItem.text = "Copilot Ntfy: $(eye-closed)";
  const md = new vscode.MarkdownString(
    "**Copilot Ntfy** is idle\n\n" +
    "[Start watching](command:copilotNtfy.startWatching) · " +
    "[Open settings](command:copilotNtfy.openSettings)"
  );
  md.isTrusted = true;
  statusBarItem.tooltip = md;
  statusBarItem.command = "copilotNtfy.startWatching";
}

// ── Config helpers ────────────────────────────────────────────
function getConfig() {
  return vscode.workspace.getConfiguration("copilotNtfy");
}

function getTopic(): string {
  return getConfig().get<string>("ntfyTopic", "").trim();
}

function getNtfyServer(): string {
  return getConfig().get<string>("ntfyServer", "https://ntfy.sh").trim();
}

function getPollInterval(): number {
  return getConfig().get<number>("pollIntervalMs", 5000);
}

// ── Prompt for topic ──────────────────────────────────────────
async function promptForTopic(): Promise<string | undefined> {
  const current = getTopic();
  const input = await vscode.window.showInputBox({
    title: "Copilot Ntfy — Set ntfy Topic",
    prompt: "Enter your ntfy.sh topic (e.g. my-copilot-jobs)",
    value: current,
    placeHolder: "my-copilot-jobs",
    validateInput: (v) => (v.trim() ? undefined : "Topic cannot be empty"),
  });

  if (input?.trim()) {
    await getConfig().update(
      "ntfyTopic",
      input.trim(),
      vscode.ConfigurationTarget.Global
    );
    return input.trim();
  }
  return undefined;
}

// ── Start / Stop (core polling, no UI side-effects) ──────────
function _startPolling() {
  isWatching = true;
  currentLogPath = "";
  lastByteOffset = 0;
  pendingCcreqLine = "";
  pendingTurnCount = 0;
  pendingJobStartMs = 0;
  pendingPromptFiltered = false;
  setStatusWatching();
  if (!pollTimer) {
    pollTimer = setInterval(pollLog, getPollInterval());
  }
}

function _stopPolling() {
  isWatching = false;
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = undefined;
  }
  setStatusIdle();
}

// Triggered by fs.watchFile when another window changes the shared state file
function syncFromSharedState() {
  const newWatching = readSharedIsWatching();
  if (newWatching === isWatching) return;
  if (newWatching) {
    _startPolling();
  } else {
    _stopPolling();
  }
}

// ── Start / Stop (user-facing commands) ──────────────────────
async function startWatching() {
  if (isWatching) {
    vscode.window.showInformationMessage("Copilot Ntfy is already watching.");
    return;
  }

  // Ensure topic is set
  let topic = getTopic();
  if (!topic) {
    topic = (await promptForTopic()) ?? "";
    if (!topic) {
      vscode.window.showWarningMessage(
        "Copilot Ntfy: No topic set — watching cancelled."
      );
      return;
    }
  }

  _startPolling();
  writeSharedIsWatching(true); // broadcast to all other windows
  vscode.window.showInformationMessage(
    `Copilot Ntfy: Watching → ${getNtfyServer()}/${topic}`
  );
}

function stopWatching() {
  if (!isWatching) return;
  _stopPolling();
  writeSharedIsWatching(false); // broadcast to all other windows
  vscode.window.showInformationMessage("Copilot Ntfy: Stopped watching.");
}

// ── Log file finder ───────────────────────────────────────────
function findLatestCopilotLog(): string {
  // Always use the Copilot Chat log that belongs to this specific VS Code window.
  // windowExtHostLogDir is derived from context.logUri which is unique per window,
  // so each window's extension instance watches only its own log.
  if (!windowExtHostLogDir) return "";
  const candidate = path.join(windowExtHostLogDir, "GitHub.copilot-chat", "GitHub Copilot Chat.log");
  return fs.existsSync(candidate) ? candidate : "";
}

// ── Poll loop ─────────────────────────────────────────────────
function pollLog() {
  const logPath = findLatestCopilotLog();
  if (!logPath) return;

  // Switched to a newer log file (new VS Code window / session)
  if (logPath !== currentLogPath) {
    currentLogPath = logPath;
    try {
      lastByteOffset = fs.statSync(logPath).size;
    } catch {
      lastByteOffset = 0;
    }
    pendingCcreqLine = "";
    return;
  }

  let currentSize: number;
  try {
    currentSize = fs.statSync(logPath).size;
  } catch {
    return;
  }

  if (currentSize <= lastByteOffset) return;

  // Read only new bytes
  let newContent = "";
  try {
    const fd = fs.openSync(logPath, "r");
    const length = currentSize - lastByteOffset;
    const buf = Buffer.alloc(length);
    try {
      fs.readSync(fd, buf, 0, length, lastByteOffset);
      newContent = buf.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return;
  }

  lastByteOffset = currentSize;

  // Process line by line
  const lines = newContent.split("\n");
  for (const line of lines) {
    // Cache the last ccreq success line for editAgent (one LLM turn, may be many per job)
    // Matches both [panel/editAgent] and [panel/editAgent-external] (BYOK)
    if (/ccreq:.*\| success \|.*\[panel\/editAgent/.test(line)) {
      if (pendingTurnCount === 0) pendingJobStartMs = Date.now();
      pendingCcreqLine = line;
      pendingTurnCount++;
    }

    // ccreq cancelled/canceled for editAgent → notify immediately (user stopped the job)
    if (/ccreq:.*\| cancell?ed \|.*\[panel\/editAgent/.test(line)) {
      const jobInfo = parseJobInfo(line, pendingTurnCount, pendingJobStartMs);
      pendingCcreqLine = "";
      pendingTurnCount = 0;
      pendingJobStartMs = 0;
      // handleJobCancelled(jobInfo);
    }

    // ccreq promptFiltered → content safety / RAI filter hit upstream
    // Fires in [copilotLanguageModelWrapper] context, followed by failed in editAgent.
    // We set a flag so the subsequent editAgent failed line notifies as "filtered" instead.
    if (/ccreq:.*\| promptFiltered \|/.test(line)) {
      pendingPromptFiltered = true;
    }

    // ccreq failed for editAgent → network/API/auth error (real keyword confirmed from logs)
    // If a promptFiltered was just seen upstream, report it as filtered instead.
    if (/ccreq:.*\| failed \|.*\[panel\/editAgent/.test(line)) {
      const jobInfo = parseJobInfo(line, pendingTurnCount, pendingJobStartMs);
      pendingCcreqLine = "";
      pendingTurnCount = 0;
      pendingJobStartMs = 0;
      if (pendingPromptFiltered) {
        pendingPromptFiltered = false;
        handleJobFiltered(jobInfo);
      } else {
        handleJobFailure(jobInfo);
      }
    }

    // ccreq timeout for editAgent → backend too slow or network stalled
    if (/ccreq:.*\| timeout \|.*\[panel\/editAgent/.test(line)) {
      const jobInfo = parseJobInfo(line, pendingTurnCount, pendingJobStartMs);
      pendingCcreqLine = "";
      pendingTurnCount = 0;
      pendingJobStartMs = 0;
      handleJobTimeout(jobInfo);
    }

    // ccreq empty for editAgent → model returned 0 choices
    if (/ccreq:.*\| empty \|.*\[panel\/editAgent/.test(line)) {
      const jobInfo = parseJobInfo(line, pendingTurnCount, pendingJobStartMs);
      pendingCcreqLine = "";
      pendingTurnCount = 0;
      pendingJobStartMs = 0;
      handleJobEmpty(jobInfo);
    }

    // ccreq unknown for editAgent → unexpected/unrecognised outcome
    if (/ccreq:.*\| unknown \|.*\[panel\/editAgent/.test(line)) {
      const jobInfo = parseJobInfo(line, pendingTurnCount, pendingJobStartMs);
      pendingCcreqLine = "";
      pendingTurnCount = 0;
      pendingJobStartMs = 0;
      handleJobError(jobInfo);
    }

    // ToolCallingLoop stop = entire agent job finished normally
    if (line.includes("[ToolCallingLoop] Stop hook result: shouldContinue=false")) {
      const jobInfo = parseJobInfo(pendingCcreqLine, pendingTurnCount, pendingJobStartMs);
      pendingCcreqLine = "";
      pendingTurnCount = 0;
      pendingJobStartMs = 0;
      handleJobComplete(jobInfo);
    }

    // ToolCallingLoop/editAgent runtime error (e.g. unhandled exception in loop)
    if (
      /\[ToolCallingLoop\].*[Ee]rror/.test(line) ||
      /\[editAgent\].*[Ee]rror/.test(line)
    ) {
      const errorMatch = line.match(/[Ee]rror[:\s]+(.+)/);
      const reason = errorMatch ? errorMatch[1].trim() : "Unknown error";
      const jobInfo = parseJobInfo(pendingCcreqLine, pendingTurnCount, pendingJobStartMs);
      pendingCcreqLine = "";
      pendingTurnCount = 0;
      pendingJobStartMs = 0;
      handleJobError(jobInfo, reason);
    }
  }
}

// ── Parse model + duration from ccreq line ────────────────────
function formatDuration(ms: number): string {
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  const m = Math.floor(ms / 60000);
  const s = Math.round((ms % 60000) / 1000);
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

function parseJobInfo(line: string, turns = 0, jobStartMs = 0): JobInfo {
  if (!line) {
    return { model: "unknown", duration: "?", turns };
  }

  // Total job duration if we have a start time; fall back to last-call duration from log line
  let duration: string;
  if (jobStartMs > 0) {
    duration = formatDuration(Date.now() - jobStartMs);
  } else {
    const durationMatch = line.match(/(\d+ms)/g);
    duration = durationMatch ? durationMatch[durationMatch.length - 1] : "?";
  }
  // Extract model from any known ccreq status keyword
  const ALL_STATUSES = "success|cancelled|canceled|failed|promptFiltered|filtered|timeout|empty|unknown";
  const modelMatch = line.match(
    new RegExp(`\\| (?:${ALL_STATUSES}) \\| ([^|]+?) \\| \\d+ms`)
  );
  const rawModel = modelMatch ? modelMatch[1].trim() : "unknown";
  const model = rawModel.includes("->") ? rawModel.split("->")[0].trim() : rawModel;

  // Extract HTTP error code (401, 403, 429, 500, …) or system error code
  const httpCodeMatch = line.match(/\b([45]\d{2})\b/);
  const sysCodeMatch = line.match(/\b(ETIMEDOUT|ECONNRESET|ENOTFOUND|ECONNREFUSED)\b/);
  const errorCode = httpCodeMatch?.[1] ?? sysCodeMatch?.[1];

  return { model, duration, turns, errorCode };
}

// ── Job outcome handlers ──────────────────────────────────────
function handleJobComplete(job: JobInfo) {
  const workspace = vscode.workspace.workspaceFolders?.[0]?.name ?? "";
  const turnsStr = job.turns > 1 ? ` · ${job.turns} turns` : "";
  const meta = `${job.model}${turnsStr} · ${job.duration}`;
  const msgLines = workspace ? [workspace, meta] : [meta];
  sendNtfy("Copilot Job Finished", msgLines.join("\n"), "default", "robot,white_check_mark");
}

function handleJobCancelled(job: JobInfo) {
  const message = `Model: ${job.model} (${job.duration})`;
  sendNtfy("Copilot Job Cancelled", message, "default", "robot,no_entry_sign");
}

function handleJobFailure(job: JobInfo) {
  let detail = "";
  let title = "Copilot Job Failed";
  if (job.errorCode === "429") {
    title = "Copilot Rate Limited";
    detail = "\nRate limit hit — try again in a moment.";
  } else if (job.errorCode === "401" || job.errorCode === "403") {
    title = "Copilot Auth Error";
    detail = `\nHTTP ${job.errorCode} — check your GitHub login.`;
  } else if (job.errorCode) {
    detail = `\nError: ${job.errorCode}`;
  }
  const message = `Model: ${job.model} (${job.duration})${detail}`;
  sendNtfy(title, message, "high", "robot,x");
}

function handleJobFiltered(job: JobInfo) {
  const message = `Model: ${job.model} (${job.duration})\nContent safety or copyright filter triggered.`;
  sendNtfy("Copilot Request Filtered", message, "default", "robot,warning");
}

function handleJobTimeout(job: JobInfo) {
  const code = job.errorCode ? ` (${job.errorCode})` : "";
  const message = `Model: ${job.model} (${job.duration})${code}`;
  sendNtfy("Copilot Job Timed Out", message, "high", "robot,hourglass_flowing_sand");
}

function handleJobEmpty(job: JobInfo) {
  const message = `Model: ${job.model} (${job.duration})\nModel returned 0 choices.`;
  sendNtfy("Copilot Empty Response", message, "default", "robot,question");
}

function handleJobError(job: JobInfo, reason?: string) {
  const detail = reason ? `\nReason: ${reason}` : "";
  const message = `Model: ${job.model} (${job.duration})${detail}`;
  sendNtfy("Copilot Job Failed", message, "high", "robot,x");
}

// ── Send ntfy notification ────────────────────────────────────
function sendNtfy(title: string, body: string, priority = "default", tags = "robot,white_check_mark") {
  const server = getNtfyServer();
  const topic = getTopic();
  if (!topic) return;

  // Dedup: skip if the exact same notification was already sent within NOTIF_DEDUP_MS
  // (guards against two extension instances — e.g. installed + dev host — double-firing)
  const notifKey = `${title}\x00${body}`;
  const state = readSharedStateData();
  const now = Date.now();
  if (state.lastNotifKey === notifKey && now - (state.lastNotifTs ?? 0) < NOTIF_DEDUP_MS) {
    return;
  }
  writeSharedStateData({ ...state, lastNotifKey: notifKey, lastNotifTs: now });

  let url: URL;
  try {
    url = new URL(`${server}/${topic}`);
  } catch {
    vscode.window.showWarningMessage(
      `Copilot Ntfy: Invalid ntfy server URL — "${server}". Please check your settings.`
    );
    return;
  }
  const isHttps = url.protocol === "https:";
  const lib = isHttps ? https : http;

  const bodyBuf = Buffer.from(body, "utf8");

  const options: http.RequestOptions = {
    hostname: url.hostname,
    port: url.port || (isHttps ? 443 : 80),
    path: url.pathname,
    method: "POST",
    headers: {
      "Content-Type": "text/plain",
      "Content-Length": bodyBuf.length,
      Title: title,
      Priority: priority,
      Tags: tags,
    },
  };

  const req = lib.request(options, (res) => {
    if (res.statusCode && res.statusCode >= 400) {
      vscode.window.showWarningMessage(
        `Copilot Ntfy: ntfy returned HTTP ${res.statusCode}`
      );
    }
    res.resume(); // drain the response so the socket is freed
  });

  req.on("error", (err) => {
    vscode.window.showWarningMessage(`Copilot Ntfy: Request failed — ${err.message}`);
  });

  req.write(bodyBuf);
  req.end();
}
