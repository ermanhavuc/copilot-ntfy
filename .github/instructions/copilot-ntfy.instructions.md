---
description: 'Cross-cutting concerns for copilot-ntfy: security (OWASP), performance, and documentation hygiene tailored to the VS Code extension and its polling/notification architecture'
applyTo: '**/*.ts'
---

# copilot-ntfy Cross-Cutting Guidelines

Applies to all TypeScript source files (`src/extension.ts`, `src/utils.ts`, `src/test/**`).  
These rules complement **AGENTS.md** (conventions, pitfalls, architecture) and do **not** repeat what is documented there.

---

## Security & OWASP

Your primary directive is to keep all generated, reviewed, or refactored code **secure by default**. When in doubt, choose the more secure option and explain the reasoning.

### A02 – Cryptographic Failures: Secrets & Configuration

- **Never hardcode** the ntfy topic, server URL, or any credential in source code.  
  Always read from VS Code configuration (`vscode.workspace.getConfiguration`).
- Read the ntfy server URL from user config and treat it as **untrusted input** — validate its scheme (`http`/`https`) before passing it to `http.request` / `https.request`.
- If a future version stores tokens, use VS Code's `SecretStorage` API, not `globalState` or plain files.

```typescript
// GOOD: read from config, validate scheme
const serverUrl = vscode.workspace.getConfiguration('copilotNtfy').get<string>('server') ?? 'https://ntfy.sh';
const parsed = new URL(serverUrl);
if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
  throw new Error(`Invalid ntfy server URL scheme: ${parsed.protocol}`);
}
```

### A01 / A10 – Access Control & SSRF

- The ntfy POST in `sendNtfy` makes an outbound HTTP request to a URL that comes from user configuration. Validate the hostname/scheme against an allow-list or at minimum ensure it is a valid HTTP/HTTPS URL before sending.
- Do **not** follow redirects automatically — the existing code intentionally does not; preserve this behaviour.
- When reading the Copilot Chat log file, always resolve the path from `windowExtHostLogDir` (derived from `context.logUri`), never from user-controlled input, to prevent path traversal.

### A08 – Software & Data Integrity

- The `watchState.json` file is written and read for cross-window IPC. Always validate the shape of the parsed JSON before trusting any field:

```typescript
// GOOD: guard parsed state before use
const raw = JSON.parse(content);
const lastKey: string = typeof raw.lastNotifKey === 'string' ? raw.lastNotifKey : '';
const lastTs: number = typeof raw.lastNotifTs === 'number' ? raw.lastNotifTs : 0;
```

### A05 – Security Misconfiguration

- Do not log sensitive content (prompt text, ntfy topic) at `console.log` / info level — use debug-only output or omit entirely.
- Ensure error messages surfaced to users do not reveal internal file paths or stack traces.

### General

- When identifying a security issue in a code review, provide the corrected code **and** explain the associated risk (e.g., "Using URL validation here to prevent SSRF.").

---

## Performance

Measure before optimising. The poll loop runs every 5 000 ms by default — focus on keeping that path allocation-free and non-blocking.

### Poll Loop (`pollLog` in `extension.ts`)

- **Read only new bytes** via `lastByteOffset` — never re-scan the entire log file on each tick. This is already the design; do not regress it.
- Use `fs.open` + `fs.read` (or equivalent) with a pre-allocated buffer rather than `fs.readFile` which allocates a fresh Buffer every call for large files.
- All regexes that match log lines must be **pre-compiled at module load** (top-level `const RE_CCREQ = /…/` etc.) — never construct `new RegExp(…)` inside the poll function or per-line loop.
- Process only the byte range `[lastByteOffset, fileSize)` per tick; if the range is zero bytes, return immediately without further allocation.

### Regex Discipline

- Avoid regexes in hot paths that use catastrophic backtracking patterns (nested quantifiers on overlapping character classes).
- Keep patterns anchored where the log line structure allows it.
- If a new pattern is added, benchmark it against representative log lines before committing.

### File Watching (`watchState.json`)

- The `fs.watchFile` poll interval is 500 ms — do not reduce it further without profiling; smaller intervals increase CPU wake-ups.
- Avoid parsing `watchState.json` more than once per polling tick; cache the parsed object if the mtime has not changed.

### General Node.js

- Prefer `fs.promises` or the callback form of `fs.*` over synchronous variants (`readFileSync`, etc.) **except** in the one-time activation path where blocking briefly is acceptable.
- Do not load optional dependencies inside the poll loop; require/import once at module level.
- Keep the pending-state machine (`pendingCcreqLine`, `pendingTurnCount`, `pendingJobStartMs`, `pendingPromptFiltered`) as four plain module-level variables — do not box them into objects that allocate on every tick.

---

## Documentation on Code Change

Update documentation **in the same commit** as the code change. Documentation-only PRs for behaviour already shipped are a code smell.

### When to Update `README.md`

Update [README.md](../../README.md) when:

- A new user-visible feature, command, or configuration option is added
- An existing command or config key is renamed or removed
- The ntfy payload format or notification content changes
- Installation or activation prerequisites change

### When to Update `CHANGELOG.md`

Add a changelog entry under the correct section for **every** user-visible change:

| Section   | Examples                                                   |
| --------- | ---------------------------------------------------------- |
| `Added`   | New command, new config option, new notification trigger   |
| `Changed` | Behaviour change, payload format change, config key rename |
| `Fixed`   | Bug fix that changes observable behaviour                  |
| `Removed` | Removed command, removed config option                     |

Format: `## [x.y.z] - YYYY-MM-DD` per [keepachangelog.com](https://keepachangelog.com).

### When to Update `AGENTS.md`

Update [AGENTS.md](../../AGENTS.md) when:

- The architecture changes (new source files, new module-level state, new IPC mechanism)
- A new convention is established or an existing one is retired
- A new pitfall is discovered (e.g., a new log format edge case)
- Build or test commands change

### Code Examples in Docs

- All code examples in `README.md` must compile and run against the current API.
- When a function signature in `utils.ts` changes, update any snippet in `README.md` that references it.
- Run `npm run compile` to verify TypeScript examples before committing.

### Review Checklist

Before considering a change complete, verify:

- [ ] `README.md` reflects the current feature set
- [ ] `CHANGELOG.md` has an entry for every user-visible change
- [ ] `AGENTS.md` is up to date if architecture or conventions changed
- [ ] No dead code or unreachable branches introduced
- [ ] `npm test` passes (implies `npm run compile` succeeded)
