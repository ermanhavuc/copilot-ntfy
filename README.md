# Copilot Ntfy Notifier

A VS Code extension that sends [ntfy.sh](https://ntfy.sh) push notifications when a **GitHub Copilot agent job** finishes — so you can walk away and get pinged on your phone when Copilot is done.

## Features

- Automatically detects when a Copilot agent (`editAgent`) job completes by tailing the Copilot Chat log file.
- Pushes a notification to your ntfy topic with the model name and duration.
- Status bar indicator shows whether the watcher is active.
- Configurable poll interval, ntfy server, and topic.
- Auto-starts on VS Code launch when a topic is already configured.

## Requirements

- [GitHub Copilot Chat](https://marketplace.visualstudio.com/items?itemName=GitHub.copilot-chat) extension installed and signed in.
- An [ntfy.sh](https://ntfy.sh) account (or self-hosted ntfy server) with a topic set up.
- An app on your phone subscribed to the same topic (ntfy is available for [Android](https://play.google.com/store/apps/details?id=io.heckel.ntfy) and [iOS](https://apps.apple.com/app/ntfy/id1625396347)).
- macOS or Linux (the extension reads the VS Code log directory; Windows support is not yet included).

## Getting Started

1. Install the extension.
2. Open the Command Palette (`⇧⌘P`) and run **Copilot Ntfy: Set ntfy Topic**.
3. Enter your ntfy topic (e.g. `my-copilot-jobs`).
4. Watching starts automatically. You'll see `Copilot Ntfy: 👁` in the status bar.

## Configuration

| Setting | Default | Description |
|---|---|---|
| `copilotNtfy.ntfyServer` | `https://ntfy.sh` | ntfy server URL (use your self-hosted URL if applicable) |
| `copilotNtfy.ntfyTopic` | _(empty)_ | ntfy topic to publish notifications to |
| `copilotNtfy.pollIntervalMs` | `5000` | How often to poll the log file in milliseconds |
| `copilotNtfy.autoStart` | `true` | Automatically start watching when VS Code opens |

## Commands

| Command | Description |
|---|---|
| `Copilot Ntfy: Start Watching` | Begin watching the Copilot Chat log |
| `Copilot Ntfy: Stop Watching` | Stop watching |
| `Copilot Ntfy: Set ntfy Topic` | Set or update the ntfy topic |

## How it Works

The extension polls the **GitHub Copilot Chat** log file (located under `~/Library/Application Support/Code/logs` on macOS or `~/.config/Code/logs` on Linux). It watches for `ToolCallingLoop` stop events to detect job completion, then reads the preceding request line to extract the model name and duration, and POSTs to your ntfy server.

No Copilot API calls are made; the extension is purely passive and read-only with respect to Copilot itself.

## Privacy

All notification traffic goes directly from your machine to your configured ntfy server. No data is sent to any third party by this extension.

## License

[MIT](LICENSE)
