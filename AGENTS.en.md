# Notes for coding agents

English ｜ [繁體中文](AGENTS.md)

This file is for AI agents (Claude Code, Codex, etc.) picking up this repo. User docs live in [README.en.md](README.en.md).

## What this is

baton is a Claude Code hooks plugin (the plugin's `hooks/hooks.json` points at one JS module). It draws a work board in a side pane and, right before the prompt cache expires, automatically runs "write handoff → compact conversation". No build step, no npm dependencies.

## Files

| Path | Contents |
| --- | --- |
| `hooks/register.js` | All the code: state, hook handlers, board rendering. Entry point is `export function register(on, options)` |
| `hooks/hooks.json` | Declares the module `./register.js` |
| `.claude-plugin/plugin.json` | Plugin name, version, `userConfig` (settings shown in `/config`) |
| `.claude-plugin/marketplace.json` | Lets this repo itself be added as a marketplace |
| `.claude-plugin/types/` | Type declarations shipped by Claude Code (`claude-code`, `claude-code-tools`, `claude-code-mcp`); gitignored, don't edit |
| `tests/board.test.ts` | Tests, using `test`, `mock`, `expect` from `claude-code/testing` |
| `README.md` / `README.en.md` | User docs (Chinese / English) |

## Structure of register.js

Top to bottom:

1. **Constants**: cache TTLs (`CACHE_TTLS`), handoff lead time (`LEAD_MS` = 5 min), minimum context (`MIN_CONTEXT_PERCENT` = 20), lane state order and look (`LANE_ORDER`, `LANE_LOOK`), memory layers (`LAYERS`), all UI and prompt text (`I18N`)
2. **Module-level state**: `let` variables (UI, run state, herdr, lanes, memory, handoff, `phase`). One copy of state per session
3. **Helpers**: path expansion (`expandPath`, `resolvePaths`), memory parsing (`parseMemory`), lanes (`loadLanes`, `laneStanding`, …), herdr (`parseHerdr`, `refreshHerdr`), handoff (`briefing`, `handoffPrompt`, `startHandoff`, `runCompact`, `checkTrigger`)
4. **`register(on, options)`** registers hooks:
   - `session.start`: load settings and data, start the 1 s tick (`$.clock.every`), register `/board` and `/handoff`
   - `prompt.submit`: attach `briefing()` to the user's first prompt (`e.context`)
   - `turn.start` / `turn.step` / `turn.complete`: run state, cache timer (`lastRequestAt`), trigger compaction after the handoff turn
   - `session.compact`, `classic.PostCompact`: save the compaction summary
   - `tool.call`: track tool calls, detect herdr commands inside Bash
   - `ui.render` (`AbovePrompt`, `Pane`): draw the launcher button and the board
5. The board is built in `ui.render { component: 'Pane' }`: `$.ui.resolve(e)` returns `Box`, `Button`, `Markdown`, etc., and rows are assembled from `tab` and `route` (the sub-page stack of the Tasks tab).

### Handoff state machine

`phase`: `idle` → `handoff` (the handoff instruction was sent, prefixed with the current language's `handoffPrefix`) → `compacting` → `idle`.

- `checkTrigger` runs every second and calls `startHandoff` only if all hold: `activated` (session ran `/board`), `auto`, `armed` (re-armed only after new user activity), `cacheTtl === '1h'`, 0–5 minutes remaining, user not away longer than `away_hours`, context ≥ 20%
- Only the turn whose `turn.start` text contains `HANDOFF_PREFIX` counts as the handoff turn (the engine prefixes plugin messages, so use `includes`, not `startsWith`)
- If that turn is aborted, don't compact; if `session.compact` is refused (a turn is still running), retry up to 6 times
- With `tasks_dir`, the instruction and briefing switch to the lane status file variant (`laneBriefing`, the `tasksDir` branch of `handoffPrompt`)

## Conventions

- **UI language**: everything the user sees (board, toasts, command descriptions) and everything sent to Claude (briefing, handoff and compaction instructions) lives in `I18N` and is read through `T.xxx`; never hard-code strings. Every new entry needs both `zh-TW` and `en`. The language is chosen in `session.start` by `detectLanguage`
- **Docs**: when UI text or behavior changes, update both `README.md` and `README.en.md`. Code comments and test names are currently in Traditional Chinese
- **Style**: 2-space indent, single quotes, no semicolons, trailing commas; match the surrounding code
- **Comments**: explain *why*, especially engine constraints (e.g. "can't call prompt.submit inside command.run")
- **Paths**: always normalized to `/`; compare with `samePath` (case-insensitive). New features must handle macOS (`HOME`) and Windows (`USERPROFILE`, drive letters)
- **Errors**: a failed read must not throw and break the board; store it in `note` or the relevant `*Error` variable and show it
- **External commands**: herdr is called only through `$.process.run`, using `herdrBin` (`HERDR_BIN_PATH` or `herdr`)
- **Redraw**: call `$.ui.invalidate('ui.render')` after state changes; the tick doesn't redraw while the board is closed
- **Persistence**: values that must survive reloads go in `$.store`, keyed with `sessionId` (e.g. `times:<id>`, `herdr:<id>`)
- **Settings**: a new user setting touches `userConfig` in `plugin.json`, the `options` reads at the top of `register()`, and the settings table in both READMEs
- **Version**: bump `version` in `plugin.json` when behavior changes

## Tests

```bash
claude plugin test
```

- Names, projects and paths in tests are fictional; never put real usernames or paths there
- `setup(on, { ... })` stubs files and environment; defaults to macOS, `{ windows: true }` switches to Windows
- Control time through `$.clock`, never real time
- Add or update tests for behavior changes; the work is done only when everything passes

## Check before changing

- If unsure whether the Claude Code hooks API supports something, read `.claude-plugin/types/claude-code/index.d.ts` instead of guessing
- Changes to auto-handoff trigger conditions, or anything that sends prompts / compacts without the user noticing, should be confirmed with the user first

## Where to start for common tasks

| Task | Look at |
| --- | --- |
| Change the handoff instruction | `handoffHead`, `handoffLane`, `handoffDocSteps`, `compactLane`, `compactDoc` in `I18N` |
| Change what new sessions are told | `briefing`, `laneBriefing` in `I18N` |
| Add a UI language | a new set in `I18N`, `detectLanguage`, the `language` options in `plugin.json` |
| Change trigger conditions | `checkTrigger` |
| Add a lane field | `loadLanes` (validation), `laneStanding`, the lane page in `ui.render` |
| Add a memory field | `parseMemory`, Memory tab rendering |
| Add a board tab | the `tabButton` row, branches on `tab` |
