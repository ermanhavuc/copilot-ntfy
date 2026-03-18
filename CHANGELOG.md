# Changelog

## [1.6.6] - 2026-03-18

### Changed

- Rename the unresolved `tool_calls` wait notification to `Copilot Needs Input` so it covers reply, approval, and similar user-input handoffs more accurately.

### Fixed

- Give terminal-wait notifications precedence over the generic unresolved-input notification so terminal handoffs are not mislabeled as reply waits.

## [1.6.5] - 2026-03-18

### Fixed

- Suppress the normal job-finished notification while a reply-wait or terminal-wait notification is still pending, preventing duplicate alerts for the same Copilot handoff.

## [1.6.4] - 2026-03-18

### Fixed

- Keep real reply-wait notifications alive when an unresolved `tool_calls` handoff is followed by `finish reason: [stop]` before the log goes silent.

## [1.6.3] - 2026-03-18

### Fixed

- Stop sending terminal-input wait notifications for normal Copilot terminal command execution when the wrapper success is paired with an explicit finish reason such as `stop`.

## [1.5.3] - 2026-03-18

### Added

- Notify when Copilot appears to be waiting for a user reply after an unresolved `tool_calls` handoff.
- Notify when Copilot appears to be waiting for terminal input after an unresolved `copilotLanguageModelWrapper` handoff.

### Changed

- Wait-state notifications now fire immediately once the log goes silent (one poll tick of inactivity), instead of after a fixed delay. This reduces latency from 30-60 s to ~5 s while keeping false-positive risk near zero.
- Remove turn count from notification metadata.
- Shorten the user-reply and terminal-input wait notification text.

## [1.5.2] - 2026-03-17

### Added

- Track turn count and job start time for Copilot agent jobs (improved notification context).

### Changed

- Refactor shared state handling to enable last-notification deduplication.
- Update polling and notification logic to support new JobInfo structure.
- Update icon and add missing discovery keywords (`notify`, etc.).

## [1.4.2] - 2026-03-17

### Changed

- Commented out job cancellation handling to avoid false negatives.

## [1.4.1] - 2026-03-17

### Fixed

- Improved error handling for job failures.

## [1.3.8] - 2026-03-17

### Changed

- Refactor job model parsing and notification message formatting.

## [1.3.7] - 2026-03-17

### Added

- Cross-window state synchronization (share job status across VS Code windows).

## [1.3.4] - 2026-03-17

### Added

- Added `openSettings` command and `autoStart` setting.

### Changed

- Updated icon and package metadata for better discoverability.

## [1.3.1] - 2026-03-17

### Changed

- Improved log file path resolution across platforms.
- Added `notify` keyword for marketplace discoverability.

## [1.0.0] - 2026-03-17

### Added

- Initial release.
- Polls GitHub Copilot Chat log file for `editAgent` job completions.
- Sends ntfy.sh push notifications with model name and duration.
- Status bar indicator (watching / idle).
- Commands: Start Watching, Stop Watching, Set ntfy Topic.
- Configurable ntfy server, topic, and poll interval.
- Auto-start on VS Code launch when a topic is set.
