/**
 * Unit tests for the pure utility functions exported from extension.ts.
 * Run via: npm test
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

// Import from the compiled output (CommonJS). The compile step runs first via `npm test`.
// Using a relative path from out/test/ → out/extension.js
import {
  detectWaitStateCandidate,
  formatDuration,
  parseCcreqContext,
  parseFinishReason,
  parseJobInfo,
} from "../utils";

// ── formatDuration ────────────────────────────────────────────────────────────

describe("formatDuration", () => {
  it("returns seconds for durations under a minute", () => {
    assert.equal(formatDuration(0), "0s");
    assert.equal(formatDuration(500), "1s");       // rounds up
    assert.equal(formatDuration(1000), "1s");
    assert.equal(formatDuration(45000), "45s");
    assert.equal(formatDuration(59999), "60s");    // rounds up to 60s, not 1m
  });

  it("returns minutes for durations ≥ 60 000 ms", () => {
    assert.equal(formatDuration(60000), "1m");
    assert.equal(formatDuration(90000), "1m 30s");
    assert.equal(formatDuration(120000), "2m");
    assert.equal(formatDuration(125000), "2m 5s");
  });

  it("omits seconds when remainder is 0", () => {
    assert.equal(formatDuration(180000), "3m");
  });
});

// ── parseJobInfo ──────────────────────────────────────────────────────────────
// Sample log line format observed from Copilot Chat logs:
// "2024-... ccreq: ... | success | gpt-4o | 1234ms | [panel/editAgent]"

const SUCCESS_LINE =
  "2024-01-01T00:00:00.000Z [info] ccreq: abc123 | success | gpt-4o | 1500ms | [panel/editAgent]";

const FAILED_429_LINE =
  "2024-01-01T00:00:00.000Z [info] ccreq: abc123 | failed | gpt-4o | 800ms | [panel/editAgent] 429";

const BYOK_LINE =
  "2024-01-01T00:00:00.000Z [info] ccreq: abc123 | success | gpt-4o->gpt-4o-2024 | 2000ms | [panel/editAgent-external]";

const TIMEOUT_ETIMEDOUT_LINE =
  "2024-01-01T00:00:00.000Z [info] ccreq: abc123 | timeout | gpt-4o | 5000ms | [panel/editAgent] ETIMEDOUT";

const TOOL_CALLS_LINE =
  "2026-03-18 12:15:43.470 [info] message 0 returned. finish reason: [tool_calls]";

const STOP_LINE =
  "2026-03-18 12:15:10.154 [info] message 0 returned. finish reason: [stop]";

const QUESTION_LINE =
  "2026-03-18 12:15:43.473 [info] ccreq:cbae6452.copilotmd | success | gemini-3-flash-preview | 2506ms | [panel/editAgent]";

const TERMINAL_WAIT_LINE =
  "2026-03-18 11:56:50.344 [info] ccreq:83781c9b.copilotmd | success | gpt-5.4 -> gpt-5.4-2026-03-05 | 4495ms | [copilotLanguageModelWrapper]";

describe("parseJobInfo", () => {
  it("returns unknown/? for an empty line", () => {
    const info = parseJobInfo("");
    assert.equal(info.model, "unknown");
    assert.equal(info.duration, "?");
    assert.equal(info.turns, 0);
    assert.equal(info.errorCode, undefined);
  });

  it("extracts model and duration from a success line", () => {
    const info = parseJobInfo(SUCCESS_LINE, 3, 0);
    assert.equal(info.model, "gpt-4o");
    assert.equal(info.duration, "1500ms");
    assert.equal(info.turns, 3);
    assert.equal(info.errorCode, undefined);
  });

  it("uses jobStartMs for duration when provided", () => {
    const startMs = Date.now() - 5000;
    const info = parseJobInfo(SUCCESS_LINE, 1, startMs);
    // duration should be ~5s (allow ±2s for test timing)
    assert.match(info.duration, /^[3-7]s$/);
  });

  it("extracts HTTP error code from failed line", () => {
    const info = parseJobInfo(FAILED_429_LINE);
    assert.equal(info.model, "gpt-4o");
    assert.equal(info.errorCode, "429");
  });

  it("strips BYOK model alias (takes only the part before ->)", () => {
    const info = parseJobInfo(BYOK_LINE);
    assert.equal(info.model, "gpt-4o");
  });

  it("extracts system error code (ETIMEDOUT) from timeout line", () => {
    const info = parseJobInfo(TIMEOUT_ETIMEDOUT_LINE);
    assert.equal(info.errorCode, "ETIMEDOUT");
  });

  it("returns unknown model when line has no recognisable status", () => {
    const info = parseJobInfo("some unrelated log line");
    assert.equal(info.model, "unknown");
    assert.equal(info.duration, "?");
  });

  it("passes through turns count", () => {
    const info = parseJobInfo(SUCCESS_LINE, 7, 0);
    assert.equal(info.turns, 7);
  });
});

describe("parseFinishReason", () => {
  it("extracts tool_calls finish reasons", () => {
    assert.equal(parseFinishReason(TOOL_CALLS_LINE), "tool_calls");
  });

  it("extracts stop finish reasons", () => {
    assert.equal(parseFinishReason(STOP_LINE), "stop");
  });

  it("returns undefined for unrelated lines", () => {
    assert.equal(parseFinishReason(SUCCESS_LINE), undefined);
  });
});

describe("parseCcreqContext", () => {
  it("extracts panel editAgent context", () => {
    assert.equal(parseCcreqContext(QUESTION_LINE), "panel/editAgent");
  });

  it("extracts copilot language model wrapper context", () => {
    assert.equal(parseCcreqContext(TERMINAL_WAIT_LINE), "copilotLanguageModelWrapper");
  });

  it("returns undefined for non-ccreq lines", () => {
    assert.equal(parseCcreqContext(TOOL_CALLS_LINE), undefined);
  });
});

describe("detectWaitStateCandidate", () => {
  it("detects unresolved question handoff candidates", () => {
    assert.equal(detectWaitStateCandidate(QUESTION_LINE, "tool_calls", true), "question");
  });

  it("detects unresolved terminal wait candidates", () => {
    assert.equal(detectWaitStateCandidate(TERMINAL_WAIT_LINE, undefined, true), "terminal");
  });

  it("ignores wrapper success after an explicit stop finish reason", () => {
    assert.equal(detectWaitStateCandidate(TERMINAL_WAIT_LINE, "stop", true), undefined);
  });

  it("ignores wrapper success without an active editAgent turn", () => {
    assert.equal(detectWaitStateCandidate(TERMINAL_WAIT_LINE, undefined, false), undefined);
  });

  it("ignores editAgent success when the finish reason was not tool_calls", () => {
    assert.equal(detectWaitStateCandidate(QUESTION_LINE, "stop", true), undefined);
  });
});
