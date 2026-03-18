# Copilot Ntfy Notifier

[![VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/MrCarrotLabs.copilot-ntfy?label=VS%20Code%20Marketplace)](https://marketplace.visualstudio.com/items?itemName=MrCarrotLabs.copilot-ntfy)
[![Open VSX](https://img.shields.io/open-vsx/v/MrCarrotLabs/copilot-ntfy?label=Open%20VSX)](https://open-vsx.org/extension/MrCarrotLabs/copilot-ntfy)

**Stop babysitting Copilot.** Start a long agent task, walk away, and get a push notification on your phone (and smart watch) the moment it finishes — or the moment it needs you.

This VS Code extension watches the Copilot Chat log in the background and sends [ntfy.sh](https://ntfy.sh) notifications for three situations:

| When                              | You get notified                                                    |
| --------------------------------- | ------------------------------------------------------------------- |
| ✅ **Job done**                   | Copilot finished the task                                           |
| ❓ **Waiting for your reply**     | Copilot asked a question and is blocked on your answer              |
| ⌨️ **Waiting for terminal input** | Copilot is waiting for a shell command or your terminal interaction |

## Features

- **Phone notifications via ntfy** — works with any ntfy.sh topic or self-hosted server.
- **Instant wait-state detection** — notifies within ~5 s of Copilot going idle, not after an arbitrary delay.
- **Near-zero false positives** — only fires when the log goes fully silent, so normal multi-turn runs never trigger spurious alerts.
- **Job details included** — model name, turn count, and elapsed duration in every notification.
- **Multi-window safe** — deduplicates notifications across multiple VS Code windows.
- **Status bar indicator** — shows at a glance whether the watcher is active.
- **Configurable** — poll interval, ntfy server URL, topic, and auto-start on launch.

## Requirements

- [GitHub Copilot Chat](https://marketplace.visualstudio.com/items?itemName=GitHub.copilot-chat) extension installed and signed in.
- An [ntfy.sh](https://ntfy.sh) account (or self-hosted ntfy server) with a topic set up.
- An app on your phone subscribed to the same topic (ntfy is available for [Android](https://play.google.com/store/apps/details?id=io.heckel.ntfy) and [iOS](https://apps.apple.com/app/ntfy/id1625396347)).
- macOS, Linux, or Windows.

## Getting Started

1. Install the extension.
2. Open the Command Palette (`⇧⌘P`) and run **Copilot Ntfy: Set ntfy Topic**.
3. Enter your ntfy topic (e.g. `my-copilot-jobs`).
4. Watching starts automatically. You'll see `Copilot Ntfy: 👁` in the status bar.

## Configuration

| Setting                      | Default           | Description                                              |
| ---------------------------- | ----------------- | -------------------------------------------------------- |
| `copilotNtfy.ntfyServer`     | `https://ntfy.sh` | ntfy server URL (use your self-hosted URL if applicable) |
| `copilotNtfy.ntfyTopic`      | _(empty)_         | ntfy topic to publish notifications to                   |
| `copilotNtfy.pollIntervalMs` | `5000`            | How often to poll the log file in milliseconds           |
| `copilotNtfy.autoStart`      | `false`           | Automatically start watching when VS Code opens          |

## Commands

| Command                        | Description                         |
| ------------------------------ | ----------------------------------- |
| `Copilot Ntfy: Start Watching` | Begin watching the Copilot Chat log |
| `Copilot Ntfy: Stop Watching`  | Stop watching                       |
| `Copilot Ntfy: Set ntfy Topic` | Set or update the ntfy topic        |
| `Copilot Ntfy: Open Settings`  | Open the extension settings page    |

## How it Works

The extension polls the **GitHub Copilot Chat** log file. The log directory is resolved automatically per platform:

| OS      | Log directory                             |
| ------- | ----------------------------------------- |
| macOS   | `~/Library/Application Support/Code/logs` |
| Windows | `%APPDATA%\Code\logs`                     |
| Linux   | `~/.config/Code/logs`                     |

It watches for `ToolCallingLoop` stop events to detect job completion, and tracks two additional wait states:

| Notification                              | Trigger                                                                                                                                                                                                  |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Copilot is asking you a question**      | An LLM turn finishes with `finish reason: [tool_calls]` inside `editAgent` and the log goes silent — the agent handed back control and is waiting for your reply.                                        |
| **Copilot is waiting for terminal input** | A `copilotLanguageModelWrapper` success line is seen while a job is in progress and the log goes silent — the agent is waiting for a shell command to complete or for you to interact with the terminal. |

Both wait notifications fire as soon as the log goes silent for one poll interval (~5 s). If the agent resumes on its own (normal multi-turn continuation), the wait state is cleared immediately and no notification is sent. This keeps false positives near zero.

It then reads the relevant request line to extract the model name and duration, and POSTs to your ntfy server.

No Copilot API calls are made; the extension is purely passive and read-only with respect to Copilot itself.

## Privacy

All notification traffic goes directly from your machine to your configured ntfy server. No data is sent to any third party by this extension.

## License

[MIT](LICENSE)
