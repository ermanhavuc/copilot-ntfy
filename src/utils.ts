/**
 * Pure utility functions with no VS Code dependency — extracted so they can be
 * unit-tested outside of the extension host environment.
 */

// ── Types ─────────────────────────────────────────────────────
export interface JobInfo {
  model: string;
  duration: string;
  turns: number;
  errorCode?: string; // HTTP status ("429", "401") or system code ("ETIMEDOUT")
}

export interface WaitStateClearDecision {
  clearQuestion: boolean;
  clearTerminal: boolean;
}

export interface LoopStopDecision {
  notifyCompletion: boolean;
}

export type WaitNotificationKind = "input" | "terminal";

export type WaitStateKind = "question" | "terminal";

// ── Pre-compiled regex ────────────────────────────────────────
// Extracts model name from a ccreq log line (pattern never changes at runtime)
const CCREQ_MODEL_RE = /\| (?:success|cancelled|canceled|failed|promptFiltered|filtered|timeout|empty|unknown) \| ([^|]+?) \| \d+ms/;
const CCREQ_CONTEXT_RE = /\| \[([^\]]+)\]\s*$/;
const FINISH_REASON_RE = /message 0 returned\. finish reason: \[([^\]]+)\]/;

// ── Helpers ───────────────────────────────────────────────────
export function formatDuration(ms: number): string {
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  const m = Math.floor(ms / 60000);
  const s = Math.round((ms % 60000) / 1000);
  if (s === 0) return `${m}m`;
  return `${m}m ${s}s`;
}

export function parseJobInfo(line: string, turns = 0, jobStartMs = 0): JobInfo {
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

  const modelMatch = line.match(CCREQ_MODEL_RE);
  const rawModel = modelMatch ? modelMatch[1].trim() : "unknown";
  const model = rawModel.includes("->") ? rawModel.split("->")[0].trim() : rawModel;

  // Extract HTTP error code (401, 403, 429, 500, …) or system error code
  const httpCodeMatch = line.match(/\b([45]\d{2})\b/);
  const sysCodeMatch = line.match(/\b(ETIMEDOUT|ECONNRESET|ENOTFOUND|ECONNREFUSED)\b/);
  const errorCode = httpCodeMatch?.[1] ?? sysCodeMatch?.[1];

  return { model, duration, turns, errorCode };
}

export function parseFinishReason(line: string): string | undefined {
  const match = line.match(FINISH_REASON_RE);
  return match?.[1];
}

export function getWaitStateClearDecision(
  finishReason: string,
  hasPendingQuestionWait: boolean
): WaitStateClearDecision {
  if (finishReason === "tool_calls") {
    return { clearQuestion: false, clearTerminal: false };
  }

  if (finishReason === "stop" && hasPendingQuestionWait) {
    return { clearQuestion: false, clearTerminal: true };
  }

  return { clearQuestion: true, clearTerminal: true };
}

export function getLoopStopDecision(
  hasPendingQuestionWait: boolean,
  hasPendingTerminalWait: boolean
): LoopStopDecision {
  return {
    notifyCompletion: !hasPendingQuestionWait && !hasPendingTerminalWait,
  };
}

export function getWaitNotificationKind(
  isQuestionDue: boolean,
  isTerminalDue: boolean
): WaitNotificationKind | undefined {
  if (isTerminalDue) {
    return "terminal";
  }

  if (isQuestionDue) {
    return "input";
  }

  return undefined;
}

export function parseCcreqContext(line: string): string | undefined {
  const match = line.match(CCREQ_CONTEXT_RE);
  return match?.[1];
}

export function detectWaitStateCandidate(
  line: string,
  lastFinishReason: string | undefined,
  hasPendingEditAgentTurn: boolean
): WaitStateKind | undefined {
  const context = parseCcreqContext(line);
  if (!context) return undefined;

  if (lastFinishReason === "tool_calls" && context.startsWith("panel/editAgent")) {
    return "question";
  }

  // A bare wrapper success can indicate a terminal handoff, but wrapper successes that
  // immediately follow an explicit finish reason like [stop] are common during normal
  // terminal command execution and should not notify as user input waits.
  if (
    hasPendingEditAgentTurn &&
    !lastFinishReason &&
    context === "copilotLanguageModelWrapper"
  ) {
    return "terminal";
  }

  return undefined;
}
