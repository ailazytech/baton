# Notes for coding agents

English ｜ [繁體中文](AGENTS.md)

This file is for AI agents (Claude Code, Codex, etc.) picking up this repo. User docs live in [README.en.md](README.en.md).

## What this is

baton is a Claude Code hooks plugin (the plugin's `hooks/hooks.json` points at one JS module). It draws a work board in a side pane and, right before the prompt cache expires, automatically runs "write handoff → compact conversation". No build step, no npm dependencies.

## Files

| Path | Contents |
| --- | --- |
| `hooks/register.js` | State, hook handlers, board rendering, all text (`I18N`). Entry point is `export function register(on, options)` |
| `hooks/nudges.js` | Nudge logic: failure signatures, edit/verify tracking, "done" claims, reply-language detection. Pure functions |
| `hooks/notes.js` | Auto-notes logic: parse and validate the notes model's output, rewrite memory frontmatter, said-3-times candidates. Pure functions |
| `hooks/guards.js` | Guard logic: match tool arguments, pick candidates, validate drafts. Pure functions |
| `hooks/hooks.json` | Declares the module `./register.js` (which imports the other three) |
| `.claude-plugin/plugin.json` | Plugin name, version, `userConfig` (settings shown in `/config`) |
| `.claude-plugin/marketplace.json` | Lets this repo itself be added as a marketplace |
| `.claude-plugin/types/` | Type declarations shipped by Claude Code (`claude-code`, `claude-code-tools`, `claude-code-mcp`); gitignored, don't edit |
| `tests/board.test.ts` | Integration tests, using `test`, `mock`, `expect` from `claude-code/testing` |
| `tests/logic.test.ts` | Pure-function tests for `nudges.js`, `notes.js`, `guards.js` |
| `README.md` / `README.en.md` | User docs (Chinese / English) |

## Structure of register.js

Top to bottom:

1. **Constants**: cache TTLs (`CACHE_TTLS`), handoff lead time (`LEAD_MS` = 5 min), minimum context (`MIN_CONTEXT_PERCENT` = 20), lane state order and look (`LANE_ORDER`, `LANE_LOOK`), memory layers (`LAYERS`), all UI and prompt text (`I18N`)
2. **Module-level state**: `let` variables (UI, run state, herdr, lanes, memory, handoff, `phase`). One copy of state per session
3. **Helpers**: path expansion (`expandPath`, `resolvePaths`), memory parsing (`parseMemory`), lanes (`loadLanes`, `laneStanding`, …), herdr (`parseHerdr`, `refreshHerdr`), handoff (`briefing`, `handoffPrompt`, `startHandoff`, `runCompact`, `checkTrigger`)
4. **`register(on, options)`** registers hooks:
   - `session.start`: load settings and data, start the 1 s tick (`$.clock.every`), register `/board`, `/handoff`, `/distill`, `/guard`
   - `prompt.submit`: attach `briefing()`, said-3-times requests (`T.promote`) and guards to ask about (`T.guardAsk`) to the user's first prompt; log every user message for notes (`recordTalk`) and carry the previous turn's reply-language reminder
   - `turn.start` / `turn.step` / `turn.complete`: run state, cache timer (`lastRequestAt`), trigger compaction after the handoff turn; `turn.step` checks the reply language, `turn.complete` logs the answer and triggers notes every `distill_every` messages
   - `classic.Stop`: return `block` when Claude claims done without verifying (`doneCheck`)
   - `session.compact`, `classic.PostCompact`: save the compaction summary
   - `tool.call`: guard matching (`findGuardHit`; deny returns `deny`), track tool calls, nudges (`watchCall`: repeated failures, edit/verify), detect herdr commands inside Bash, reload memory / guards when their files are written
   - `ui.render` (`AbovePrompt`, `Pane`): draw the launcher button and the board
5. The board is built in `ui.render { component: 'Pane' }`: `$.ui.resolve(e)` returns `Box`, `Button`, `Markdown`, etc., and rows are assembled from `tab` and `route` (the sub-page stack of the Tasks tab).

### Handoff state machine

`phase`: `idle` → `handoff` (the handoff instruction was sent, prefixed with the current language's `handoffPrefix`) → `compacting` → `idle`.

- `checkTrigger` runs every second and calls `startHandoff` only if all hold: `activated` (session ran `/board`), `auto`, `armed` (re-armed only after new user activity), `cacheTtl === '1h'`, 0–5 minutes remaining, user not away longer than `away_hours`, context ≥ 20%
- Only the turn whose `turn.start` text contains `HANDOFF_PREFIX` counts as the handoff turn (the engine prefixes plugin messages, so use `includes`, not `startsWith`)
- If that turn is aborted, don't compact; if `session.compact` is refused (a turn is still running), retry up to 6 times
- With `tasks_dir`, the instruction and briefing switch to the lane status file variant (`laneBriefing`, the `tasksDir` branch of `handoffPrompt`)
- `startHandoff` also kicks off a notes pass (a separate `$.model.complete` request that doesn't occupy the main conversation)

### Auto notes and guards

- The conversation log (`talk`) is kept per project in `$.store` under `talk:<project slug>` (not per session: whatever wasn't distilled must carry over to the next session). It holds only messages the user typed (`composer` / `bridge` in `prompt.submit`, slash commands excluded) and the main thread's answers. The sent portion is dropped only after a successful pass; on failure it stays for the next one
- Every entry in the notes model's output must carry a `quote`, which `parseActions` checks against the user's own messages and drops on mismatch. This keeps the model from recording Claude's words or its own inferences as user requests — don't remove it
- Memory files are changed only in frontmatter `metadata` (`setMeta`), never in the body; new memories get `metadata.source: baton`
- Guards live in `{config}/projects/{project}/baton-guards.json`. When the user agrees, Claude edits that file directly (`tool.call` reloads it when it's written); no extra command needed
- `tool.call` is a gating hook: anything new in it must be wrapped in `try` / `catch` and let the call through on error

## Conventions

- **UI language**: everything the user sees (board, toasts, command descriptions) and everything sent to Claude or the notes model (briefing, handoff and compaction instructions, nudges, notes and guard prompts) lives in `I18N` and is read through `T.xxx`; never hard-code strings. Every new entry needs both `zh-TW` and `en`. The language is chosen in `session.start` by `detectLanguage`. The one exception is the reply-language reminder in `nudges.js`: it must be written in the *target* language (Traditional / Simplified Chinese, English, Japanese), independent of the UI language. `nudges.js`, `notes.js` and `guards.js` hold logic only; rejection reasons are short English phrases and aren't translated (used only for counts and debugging)
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
| Change what new sessions are told | `briefing`, `laneBriefing`, `promote`, `guardAsk` in `I18N` |
| Change nudges | logic in `nudges.js`; text in `retryNudge`, `doneCheck` in `I18N` |
| Change what notes record | `distillPrompt` in `I18N`; validation in `parseActions` in `notes.js` |
| Change guard drafting and matching | `guardPrompt` in `I18N`; matching and validation in `guards.js` |
| Add a UI language | a new set in `I18N`, `detectLanguage`, the `language` options in `plugin.json` |
| Change trigger conditions | `checkTrigger` |
| Add a lane field | `loadLanes` (validation), `laneStanding`, the lane page in `ui.render` |
| Add a memory field | `parseMemory`, Memory tab rendering |
| Add a board tab | the `tabButton` row, branches on `tab` |
