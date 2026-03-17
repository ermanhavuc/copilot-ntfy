import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as https from "https";
import * as http from "http";

// ── Types ─────────────────────────────────────────────────────
interface JobInfo {
  model: string;
  duration: string;
  timestamp: string;
}

// ── Globals ───────────────────────────────────────────────────
let statusBarItem: vscode.StatusBarItem;
let pollTimer: NodeJS.Timeout | undefined;
let currentLogPath = "";
let lastByteOffset = 0;
let pendingCcreqLine = "";
let isWatching = false;
let windowExtHostLogDir = ""; // set from context.logUri — unique per VS Code window
let extensionContext: vscode.ExtensionContext;

// ── Shared state (cross-window IPC) ──────────────────────────
const SHARED_STATE_FILE = "watchState.json";

function getSharedStatePath(): string {
  return path.join(extensionContext.globalStorageUri.fsPath, SHARED_STATE_FILE);
}

function readSharedIsWatching(): boolean {
  try {
    const data = JSON.parse(fs.readFileSync(getSharedStatePath(), "utf8"));
    return data.isWatching === true;
  } catch {
    return false;
  }
}

function writeSharedIsWatching(value: boolean): void {
  try {
    fs.mkdirSync(extensionContext.globalStorageUri.fsPath, { recursive: true });
    fs.writeFileSync(
      getSharedStatePath(),
      JSON.stringify({ isWatching: value }),
      "utf8"
    );
  } catch {
    // ignore write errors
  }
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
    fs.readSync(fd, buf, 0, length, lastByteOffset);
    fs.closeSync(fd);
    newContent = buf.toString("utf8");
  } catch {
    return;
  }

  lastByteOffset = currentSize;

  // Process line by line
  const lines = newContent.split("\n");
  for (const line of lines) {
    // Cache the ccreq success line for editAgent jobs
    if (/ccreq:.*\| success \|.*\[panel\/editAgent\]/.test(line)) {
      pendingCcreqLine = line;
    }

    // ToolCallingLoop stop = agent job finished ✅
    if (line.includes("[ToolCallingLoop] Stop hook result: shouldContinue=false")) {
      const jobInfo = parseJobInfo(pendingCcreqLine);
      pendingCcreqLine = "";
      handleJobComplete(jobInfo);
    }
  }
}

// ── Parse model + duration from ccreq line ────────────────────
function parseJobInfo(line: string): JobInfo {
  const timestamp = new Date().toLocaleTimeString("tr-TR", { hour12: false });

  if (!line) {
    return { model: "unknown", duration: "?", timestamp };
  }

  const durationMatch = line.match(/(\d+ms)/g);
  const duration = durationMatch ? durationMatch[durationMatch.length - 1] : "?";

  const modelMatch = line.match(/\| success \| ([^|]+)/);
  const model = modelMatch ? modelMatch[1].trim() : "unknown";

  return { model, duration, timestamp };
}

// ── Job complete handler ──────────────────────────────────────
function handleJobComplete(job: JobInfo) {
  const message = `Completed at ${job.timestamp}\nModel: ${job.model} (${job.duration})`;
  sendNtfy("✅ Copilot Job Finished", message);
}

// ── Send ntfy notification ────────────────────────────────────
function sendNtfy(title: string, body: string) {
  const server = getNtfyServer();
  const topic = getTopic();
  if (!topic) return;

  const url = new URL(`${server}/${topic}`);
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
      Priority: "default",
      Tags: "white_check_mark,robot",
    },
  };

  const req = lib.request(options, (res) => {
    if (res.statusCode && res.statusCode >= 400) {
      vscode.window.showWarningMessage(
        `Copilot Ntfy: ntfy returned HTTP ${res.statusCode}`
      );
    }
  });

  req.on("error", (err) => {
    vscode.window.showWarningMessage(`Copilot Ntfy: Request failed — ${err.message}`);
  });

  req.write(bodyBuf);
  req.end();
}
