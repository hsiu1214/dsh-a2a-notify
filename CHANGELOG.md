# Changelog

## 0.1.0 (2026-10-13)

Initial release.

- Windows balloon notifications for session lifecycle events across all
  workspaces: new session (`api-session/added`), running / finished
  (`api-session/status`), error (`api-session/error`).
- Headless coverage: `fs.watch` fallback over the session store catches
  sessions created by short-lived headless/CLI processes whose events never
  reach the desktop Host's event bus; deduplicated against the live channel.
- Scheduled-task dispatch: notification requests are written to a mailbox
  directory and shown by a per-user scheduled task running on the interactive
  desktop, bypassing the DSH process tree's desktop isolation (WinRT toast and
  direct WinForms balloons from the Host are not visible on the user's
  desktop — both verified experimentally).
- cwd allowlist (`notifyWorkspaces`) to keep your own GUI chats silent.
- Per-session dedup for repeated `added` emissions; append-only audit log at
  `~/.dsh/logs/a2a-notify.log`.
