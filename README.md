# pi-extension-wt

Pi extension that switches pi session to git worktree (like cd but for worktrees).

## Features

- **Worktree discovery**: `git worktree list` (authoritative)
- **Config**: `~/.pi/agent/wt.json` (or `.pi/wt.json`), ENV override `PI_WT_CONFIG_PATH`
- **Schema**: `{ "sort": "created" | "updated" }`, default "created"
- **Sort toggle**: TUI column header click OR key cycle, persists back to config
- **Session fork**: follows cd plugin pattern (`ctx.switchSession()`, `SessionManager.forkFrom()`)
- **TUI picker**: `/wt` opens ranked picker via `ctx.ui.select()`
- **Fallback**: `session_start` hook — if `ctx.cwd` no longer exists, fallback to main worktree
- **WebUI compatible**: `ctx.ui.select()` works in RPC mode
- **NO create/remove**: use `git worktree add` manually (YAGNI)

## Commands

```text
/wt              → TUI picker of worktrees (sortable column)
/wt <name>       → fork session to worktree
/wt --list       → show all worktrees
/wt --status     → show current worktree
```

## Config Schema

```json
{
  "sort": "created"
}
```

- `sort`: `"created"` | `"updated"` (toggle-able in TUI, persists to config)

## Install

```bash
pi install https://github.com/buihongduc132/pi-extension-wt
```

Or add to `settings.json`:

```json
{
  "packages": [
    "https://github.com/buihongduc132/pi-extension-wt"
  ]
}
```

## Fallback

If the current worktree is deleted while pi is running, the `session_start` hook detects missing `ctx.cwd`, runs `git rev-parse --show-toplevel` to find the main worktree, and switches session to main with notification "worktree gone, fell back to main".

## Pattern

Follows `@firstpick/pi-extension-cd` pattern exactly:
- `ctx.switchSession()` for session fork
- `SessionManager.forkFrom()` to preserve conversation
- `ctx.ui.select()` for TUI picker
- `ctx.ui.setStatus()` for status bar
- `ctx.ui.notify()` for notifications
- `getArgumentCompletions` for autocomplete

## License

MIT
