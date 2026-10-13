# dsh-a2a-notify

[中文说明](README.zh.md)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) host plugin that raises **real Windows balloon notifications** when a session is created, starts running, finishes, or errors — **across every workspace**, including sessions created by headless runs, CLI one-shots, and external dispatchers (A2A).

The problem it solves: tasks dropped into a workspace you are not looking at (an A2A dispatcher, `dsh --print`, another agent) run to completion silently. The sidebar only shows sessions of the workspace you have open, and nothing tells you the rest. This plugin watches the session store itself, so nothing slips through.

```
WorkBuddy/A2A dispatch → headless session lands on disk
                       → balloon: "DSH new session (headless) / new session in scripts"
                       → balloon: "DSH session finished"
```

## Why it is built this way

Two hard facts about DSH internals, both verified by experiment against 0.2.0-rc.2 (details in [Known limitations & design notes](#known-limitations--design-notes)):

1. **Headless sessions never announce themselves.** Each headless run is its own short-lived process; its `api-session/*` events die with it. So this plugin runs a second channel — `fs.watch` over the session store (`~/.dsh/sessions`) — and deduplicates against the live event channel.
2. **The DSH process tree is desktop-isolated.** Balloons spawned by the Host or any child (WinForms *or* WinRT toast, under any AppUserModelID) never reach your desktop; they fail with `0x80073D54` or are silently dropped, and never appear in the notification center. So notifications are dispatched through a **per-user scheduled task** that runs on the interactive desktop: the plugin drops a request file into a mailbox directory and triggers `a2a-notify-dispatch`, which claims files atomically and shows the balloons.

## Install

```sh
dsh plugin add github:hsiu1214/dsh-a2a-notify
```

or from a release archive:

```sh
dsh plugin add https://github.com/hsiu1214/dsh-a2a-notify/releases/latest/download/dsh-a2a-notify-0.1.0.tgz
```

**Restart DSH afterwards** (the restart-button plugin does this in one click) — plugin code is loaded at Host boot and ESM caches make hot reload unreliable.

Windows 10/11 only (the dispatcher needs PowerShell 5.1 + WinForms, both inbox).

## Events

| Event | Balloon | Notes |
| --- | --- | --- |
| `api-session/added` | "DSH new session" | any workspace; deduplicated per session (the host re-emits `added` for restored sessions) |
| `api-session/status` → running | "DSH session running" | |
| `api-session/status` → idle | "DSH session finished" | |
| `api-session/error` | "DSH session error" | |
| `api-session/activity` | — | fires on every user message; too noisy, deliberately not notified |

Append-only audit log: `~/.dsh/logs/a2a-notify.log`.

## Configuration

Optional, in your profile's `cordis.patch.yml`:

```yaml
- id: a2a-notify
  name: dsh-a2a-notify
  config:
    notifyOn:
      added: true
      running: false   # set false if per-turn balloons are too chatty
      finished: true
      error: true
    notifyWorkspaces:                # cwd prefix allowlist; empty = all
      - C:\Users\<you>\.workbuddy
      - C:\Users\<you>\WorkBuddy
```

`notifyWorkspaces` silences your own GUI chats (e.g. the workspace you type in) while keeping external dispatchers loud. Sessions with an unknown cwd always notify.

## Known limitations & design notes

- **Headless sessions do not appear in the sidebar in real time.** The data layer is complete — `POST /api/session/list` returns them (verified; they land in the sidebar's *ungrouped* group) — but the GUI only re-pulls on page load. Refresh the page (the restart-button plugin refreshes it for you) and they appear. The balloon still tells you the moment a dispatch lands.
- The plugin re-emits `api-session/added` for store-watched sessions so the GUI *can* pick them up live; whether that push survives the gateway's event-scope routing depends on the DSH version.
- Balloon display requires the scheduled-task channel. If the plugin is installed under a path containing spaces, `schtasks /tr` quoting breaks and it falls back to a direct spawn, whose balloons may not display on sandboxed desktops — install under the default (space-free) location.
- WinRT `ToastNotificationManager` is deliberately not used: sandboxed child processes have no MSIX package identity and `CreateToastNotifier` rejects them with `0x80073D54` even after `SetCurrentProcessExplicitAppUserModelID`. `NotifyIcon.ShowBalloonTip` (WinForms, inbox) renders as a standard corner notification on Win10/11 without needing any identity.

## Security

- Reads the host Cordis event bus only; registers no HTTP routes, opens no ports, no network access.
- Writes: `~/.dsh/logs/a2a-notify.log` (audit), `~/.dsh/a2a-notify/pending/` (notification mailbox), and registers one per-user scheduled task pointing exclusively at this plugin's own `dispatcher.ps1`.
- Balloon text contains session titles / workspace paths only, never conversation content.

## Uninstall

```sh
dsh plugin --profile desktop remove dsh-a2a-notify
```

or delete `~/.dsh/profiles/desktop/node_modules/dsh-a2a-notify/`, remove the two manifest registrations and the `cordis.patch.yml` config block, then `schtasks /delete /tn "a2a-notify-dispatch" /f`.

## License

MIT
