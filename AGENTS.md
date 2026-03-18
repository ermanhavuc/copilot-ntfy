# Copilot Ntfy — Project Guidelines

VS Code extension (`MrCarrotLabs.copilot-ntfy`) that sends [ntfy.sh](https://ntfy.sh) push notifications when a GitHub Copilot agent job finishes. Works by **tailing the Copilot Chat log file** — no Copilot API calls.

## Build and Test

```bash
npm install          # install devDependencies (typescript, @types/*, @vscode/vsce)
npm run compile      # tsc -p ./ → out/
npm run watch        # incremental compile
npm test             # compile + node --test out/test/utils.test.js
npm run package      # vsce package
npm run publish      # vsce publish
```

Tests use Node's built-in `node:test` runner — no Jest/Mocha. Always run `npm run compile` before running tests manually; `npm test` does this automatically.

## Architecture

```
src/
  extension.ts   # VS Code host: activation, commands, poll loop, ntfy HTTP POST
  utils.ts       # Pure, VS Code-free helpers: formatDuration(), parseJobInfo()
  test/
    utils.test.ts  # Unit tests for utils.ts only (node:test + node:assert)
```

**`activate(context)`** — entry point:

1. Derives `windowExtHostLogDir` from `context.logUri` (per-window; critical for finding the correct log).
2. Sets up status bar, four commands, and cross-window state sync via `watchState.json` in `globalStorageUri`.

**Poll loop (`pollLog`)** — runs on `setInterval` (default 5 000 ms):

- Log path: `<windowExtHostLogDir>/GitHub.copilot-chat/GitHub Copilot Chat.log`
- Reads only **new bytes** each tick via `lastByteOffset` (tail-style, no re-scan).
- Pre-compiled module-level regexes detect `ccreq` success/failed/timeout/empty lines and `ToolCallingLoop` stop hooks.

**Pending state machine** — four module-level vars (`pendingCcreqLine`, `pendingTurnCount`, `pendingJobStartMs`, `pendingPromptFiltered`) track one in-flight job.

**`sendNtfy`** — raw `http`/`https` POST (no fetch/axios) with duplicate-send guard (`lastNotifKey` + `lastNotifTs` in `watchState.json`, 5 s window).

## Conventions

- **Cross-window IPC**: file-system-based (`watchState.json` + `fs.watchFile` polling at 500 ms) — no VS Code messaging APIs.
- **Zero runtime dependencies**: only Node built-ins (`fs`, `path`, `http`, `https`) and the VS Code API.
- **All regexes pre-compiled** at module load — never use `new RegExp(...)` per line.
- **`utils.ts` must stay VS Code-free** so it can be tested with plain `node --test`.
- **BYOK model alias**: `gpt-4o->gpt-4o-2024` is normalised to `gpt-4o` (take the part before `->`) in `parseJobInfo`.
- Target: `ES2020`, module: `commonjs`, strict mode on.

## Key Pitfalls

- **Log path is per-window**: `windowExtHostLogDir` is `parent(context.logUri)`. Breaking this derivation silently tails the wrong (or nonexistent) log.
- **`promptFiltered` ordering**: the content-safety event fires in a _different log context_ before the `editAgent failed` line — tracked with a boolean flag, not by timestamp correlation.
- **Tests import from `out/`**: `import { ... } from "../utils"` resolves to `out/utils.js`. Running the test source directly without compiling first will fail.
- **No redirect following in `sendNtfy`**: if your ntfy server issues a redirect, it is silently dropped.
- **Cancelled jobs are intentionally ignored**: do not add cancellation handling without also resetting pending state.
