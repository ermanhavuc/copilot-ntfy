import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
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

// ── Activation ────────────────────────────────────────────────
export async function activate(context: vscode.ExtensionContext) {
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
    vscode.commands.registerCommand("copilotNtfy.setTopic", promptForTopic)
  );

  // Auto-start based on setting
  const autoStart = getConfig().get<boolean>("autoStart", true);
  const topic = getTopic();
  if (autoStart && topic) {
    await startWatching();
  } else if (autoStart && !topic) {
    // Prompt for topic then start
    const newTopic = await promptForTopic();
    if (newTopic) {
      await startWatching();
    }
  }
}

export function deactivate() {
  stopWatching();
}

// ── Status bar helpers ────────────────────────────────────────
function setStatusWatching() {
  statusBarItem.text = "Copilot Ntfy: $(eye)";
  statusBarItem.tooltip = "Copilot Ntfy is active — click to stop";
  statusBarItem.command = "copilotNtfy.stopWatching";
  statusBarItem.backgroundColor = undefined;
}

function setStatusIdle() {
  statusBarItem.text = "Copilot Ntfy: $(eye-closed)";
  statusBarItem.tooltip = "Copilot Ntfy is idle — click to start";
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

// ── Start / Stop ──────────────────────────────────────────────
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

  isWatching = true;
  currentLogPath = "";
  lastByteOffset = 0;
  pendingCcreqLine = "";
  setStatusWatching();

  pollTimer = setInterval(pollLog, getPollInterval());
  vscode.window.showInformationMessage(
    `Copilot Ntfy: Watching → ${getNtfyServer()}/${topic}`
  );
}

function stopWatching() {
  if (!isWatching) return;
  isWatching = false;
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = undefined;
  }
  setStatusIdle();
  vscode.window.showInformationMessage("Copilot Ntfy: Stopped watching.");
}

// ── Log file finder ───────────────────────────────────────────
function findLatestCopilotLog(): string {
  const base =
    os.platform() === "darwin"
      ? path.join(os.homedir(), "Library", "Application Support", "Code", "logs")
      : path.join(os.homedir(), ".config", "Code", "logs");

  if (!fs.existsSync(base)) return "";

  let latest = { mtime: 0, filePath: "" };

  function walk(dir: string) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (
        entry.isFile() &&
        entry.name === "GitHub Copilot Chat.log" &&
        full.includes("GitHub.copilot-chat")
      ) {
        try {
          const stat = fs.statSync(full);
          if (stat.mtimeMs > latest.mtime) {
            latest = { mtime: stat.mtimeMs, filePath: full };
          }
        } catch {
          // skip
        }
      }
    }
  }

  walk(base);
  return latest.filePath;
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
