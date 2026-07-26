# pi-extension-wt

Pi extension that switches pi session to git worktree (like cd but for worktrees).

## Features

- **Worktree discovery**: `git worktree list` (authoritative)
- **Config**: `~/.pi/agent/wt.json` (or `.pi/wt.json`), ENV override `PI_WT_CONFIG_PATH`
- **Schema**: `{ "sort": "created" | "updated" }`, default "created"
- **Sort toggle**: Press 's' key in TUI picker to cycle sort order, persists back to config
- **Session fork**: follows cd plugin pattern (`ctx.switchSession()`, `SessionManager.forkFrom()`)
- **TUI picker**: `/wt` opens ranked picker via `ctx.ui.select()`
- **Fallback**: `session_start` hook saves main worktree path to state; `/wt` command auto-switches to main when cwd is gone
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

When the session starts, the `session_start` hook saves the main worktree path to a state file (`~/.pi/agent/state/main-worktree.json`). If the current worktree is deleted while pi is running, running `/wt` (with no arguments) detects the missing `cwd` via `isCwdGone()`, reads the saved main worktree path from state via `findMainWorktree()`, and auto-switches session to main with notification "wt: cwd gone, falling back to main". This works because `switchSession` is only available from `ExtensionCommandContext` (command handlers), not from `ExtensionContext` (event handlers like `session_start`).

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
