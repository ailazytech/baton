# baton

English ｜ [繁體中文](README.md)

A side-panel work board for Claude Code (a hooks plugin). It **writes a handoff and compacts the conversation right before the prompt cache expires**, so long-running work survives cache expiry and context limits. It also brings parallel workstreams (lanes), layered memory, and agents driven through herdr into one panel.

> Requires Claude Code **2.1.287 or later** (tested on 2.1.288). macOS and Windows share the same code.

> The board, handoff instructions and briefings follow the user's language (Traditional Chinese and English for now); see `language` under Configuration.

## What it solves

Long-running work in Claude Code (an afternoon-long refactor, several agents running separate workstreams) tends to hit the same walls:

- **Step away and the cache is gone**: the prompt cache lasts an hour by default. Come back from a meeting or lunch and the next turn re-processes the whole conversation — slow and expensive, and the longer the conversation, the more tokens it burns.
- **Forced compaction loses your place**: auto-compaction happens at the worst time, and the summary may drop what you care about (the next step, the decision still waiting on you).
- **A new session starts from zero**: you paste the handoff back yourself, or spend several turns re-explaining context.
- **Parallel lanes, no idea who's waiting on you**: one agent is stuck on a permission dialog, another finished and needs review, a third failed — and you're switching pane by pane to find out.

What baton does:

- **Hands off proactively with 5 minutes of cache left**: Claude writes the goal, progress, next step and open decisions into a handoff document, then the conversation is compacted. The handoff turn runs while the cache is still warm, so it's cheap; work continues from a clean context.
- **Restores context automatically**: the first prompt of a new session (or after compaction) gets the handoff attached — no pasting.
- **One panel for every lane**: each lane is a JSON status file. "Waiting on you", "failed" and "needs review" come first with notifications; open a lane to see its live screen, send keys, or reply without switching panes.
- **Layered memory**: user preferences, project facts, lane-specific details and short-lived phase notes are kept apart, and stale ones are flagged for review.

## Quick start

```bash
claude update                                          # make sure you're on 2.1.287+
claude plugin marketplace add ailazytech/baton   # or a local path
claude plugin install baton@baton
```

Open a new session and type `/board`.

- `/board`: toggle the board. **Only sessions that have run `/board` get automatic handoff** (they become the lead session).
- `/handoff`: hand off now without opening the board. Use this when the mouse can't reach the board buttons (non-fullscreen layout).
- While the board is closed, a "◧ Work board" button appears at the top right of the prompt box (disable with `launcher_button` in `/config`).

Docking on the right requires the fullscreen layout (`CLAUDE_CODE_NO_FLICKER=1`) and a terminal at least 110 columns wide; otherwise the board sits above the prompt box.

## Features

### Tabs

- **Tasks** — only when the project sets `tasks_dir` (see "Lane status files"): one or two lines per lane plus a percentage. Lanes that need you (blocked, failed, review, dialog awaiting confirmation) come first; idle and done lanes are collapsed.
  - Click a lane to open its page: steps, decisions waiting on you, notes, live screen (`herdr pane read`, refreshed every 3 s), keys (Enter / Esc / 1 / 2 / 3), a reply box (`herdr agent prompt`), the report, and memories for that lane.
  - The report is one level deeper; "← Back" walks up one level at a time and restores the list scroll position.
  - Toasts when another lane becomes blocked, review, or failed.
- **Memory**: grouped by frontmatter `metadata.layer` into user / project / workstream / phase. Workstream memories attach to a lane page via `metadata.lane`; phase memories past `metadata.review_by` are flagged "due for review". Memories without a layer go under "unlayered", grouped by type.
- **Progress** (called **Handoff** when the Tasks tab exists): run state, todos, context usage, handoff document.
- **Herdr** — only inside herdr and when there is no Tasks tab: agents/panes this session has commanded through herdr and their live state; toasts on blocked or done.
- **Footer**: current model, cache countdown, auto-handoff toggle.

### Auto-handoff flow

1. Every request from the lead session restarts the cache timer.
2. With 5 minutes left, and when all of the following hold, the plugin sends an instruction starting with `[auto-handoff]` (`[自動交接]` in the Chinese UI) asking Claude to update the handoff document (or its own lane status file) and memory:
   - this session has run `/board` and auto-handoff is on
   - `cache_ttl` is `1h` (no auto-handoff with a 5-minute cache — it would interrupt constantly)
   - context usage is at least 20% (otherwise compaction isn't worth it)
   - the last user input is within `away_hours`, or Claude is still working
3. When the handoff turn ends, the conversation is compacted. The summary is saved next to the handoff document as `*.compact.md` and can be expanded on the board.
4. The first prompt after compaction gets the handoff document attached again (disable with `brief_on_start`). Projects without `tasks_dir` also get a note asking Claude to offer you a Tasks tab when it sees several parallel workstreams.

## Configuration

In `/config`:

| Setting | Description | Default |
| --- | --- | --- |
| `memory_dir` | Memory folder | `{config}/projects/{project}/memory` |
| `handoff_path` | Handoff document | `docs/HANDOFF.md` |
| `brief_on_start` | Attach the handoff on a new session / after compaction | on |
| `launcher_button` | Board button above the prompt box | on |
| `cache_ttl` | Prompt cache TTL, `1h` / `5m`; the value reported by the engine on model switch wins | `1h` |
| `away_hours` | Stop auto-handoff after this many hours without input (`24` / `8` / `2`) | `24` |
| `language` | UI language, `auto` / `zh-TW` / `en`. `auto` uses Claude Code's `language` setting, else `LANG`; any Chinese maps to Traditional Chinese, anything else to English | `auto` |

Paths may use `{config}` (`~/.claude` or `CLAUDE_CONFIG_DIR`), `{project}` (project slug), `{root}` (project root), and `~`. Relative paths resolve against the project root.

### Per-project overrides

Put overrides in `{config}/projects/{project}/baton.json` (outside the project repo). Changes are picked up on save. If there's no `baton.json`, the pre-rename `session-board.json` is read instead:

```json
{
  "handoff_path": "docs/migration/PROGRESS.md",
  "handoff_section": "## Handoff"
}
```

- `handoff_path`, `memory_dir`: as above
- `handoff_section`: use when the handoff document is one of the project's own docs. The board and new sessions read only the first section whose heading starts with this; auto-handoff only asks Claude to update that section, never rewrite the whole file
- `compact_path`: where the compaction summary goes. Defaults to next to the global `handoff_path`, so switching to a project doc doesn't write summaries into the repo
- `tasks_dir`: lane status folder; enables the Tasks tab
- `tasks_self`: the lead session's own status file name (default `architect`)

### Lane status files

One `<lane>.json` per lane in `tasks_dir`:

```json
{
  "lane": "api",
  "title": "Paginate REST API responses",
  "state": "working",
  "steps": [
    { "id": "S1", "title": "Inventory existing endpoints", "state": "done" },
    { "id": "S2", "title": "Add cursor parameter", "state": "doing" },
    { "id": "S3", "title": "Add tests", "state": "todo" }
  ],
  "updated": "2026-10-16T09:30:00Z",
  "notes": ["Old clients still use offset; keep it compatible for now"]
}
```

- Required: `lane`, `title` (one line), `state` (`blocked` / `failed` / `review` / `working` / `idle` / `done`), `steps` (`{ id, title, state: todo|doing|done|skip }`), `updated`
- Optional: `needs` (decision waiting on the user), `pane` (herdr pane id), `spec`, `head`, `report` (report file path), `notes`
- Percentage = done steps ÷ (total − skipped)
- Put project-specific rules and validation tooling in that folder's README

With `tasks_dir` set, handoff switches to status-file mode:

- The first prompt of a new session / after compaction gets only the lane overview plus the lead's own steps and notes; the detailed handoff document is referenced by path, to be read on demand
- Auto-handoff asks the lead to update its own status file (steps, needs, notes) instead of rewriting the handoff document

### Memory file format

One `.md` per memory in the memory folder (`MEMORY.md` is the index and isn't listed):

```markdown
---
name: no-hotkeys
description: Don't use hotkeys on the board
metadata:
  type: feedback        # user / feedback / project / reference
  layer: user           # user / project / workstream / phase
  lane: api             # for workstream: which lane it belongs to
  review_by: 2026-11-01 # for phase: flagged after this date
---

Don't add hotkeys for me.
```

## Handing this to an AI agent

[AGENTS.en.md](AGENTS.en.md) (Chinese: [AGENTS.md](AGENTS.md)) is the guide for coding agents: architecture, conventions, tests, and pitfalls. Claude Code picks it up automatically through `CLAUDE.md`.

Prompts you can paste:

**Change the plugin**

```text
Read AGENTS.en.md first, then the parts of hooks/register.js relevant to this change.
I want to: <description>.
Run `claude plugin test` when done and report only after everything passes. If behavior changes, update both README.md and README.en.md.
```

**Set up the Tasks tab in your own project**

```text
I want to use baton's Tasks tab for the parallel work in this project.
Set tasks_dir in ~/.claude/projects/<project slug>/baton.json to <folder>,
write a README in that folder describing the lane status file format and update rules,
then create a <lane>.json for each piece of ongoing work. The lead's own file is architect.json.
```

**Pick up someone else's handoff**

```text
Read <handoff path> (and the status files in tasks_dir, if any).
In 3–5 lines tell me the goal, where things stand, the next step, and anything waiting on my decision. Don't change anything yet.
```

## macOS and Windows

Paths are normalized to `/` internally; both platforms run the same code.

### Paths and folders

| Item | macOS | Windows |
| --- | --- | --- |
| Home (`~`) | `HOME`, e.g. `/Users/<name>` | `USERPROFILE`, e.g. `C:\Users\<name>` |
| Default `{config}` | `/Users/<name>/.claude` | `C:\Users\<name>\.claude` |
| Absolute paths | start with `/` | start with a drive letter (`D:/...`) |
| `{project}` slug | `/Users/<name>/Projects/app` → `-Users-<name>-Projects-app` | `D:\work\app` → `D--work-app` |
| Case sensitivity | APFS is case-insensitive by default (the plugin compares paths case-insensitively) | NTFS is case-insensitive |

- **Use relative paths in project settings**: `handoff_path`, `tasks_dir`, `compact_path` in `baton.json`, and `report`, `spec` in lane files, relative to the project root, work on both
- **If you need absolute paths**: `~/...` on macOS; `/`-separated on Windows (`D:/notes`). Backslashes in JSON must be escaped (`D:\\notes`), so `/` is less error-prone
- **Moving to another machine**: the `{project}` slug follows the project path. Copy `baton.json` and `memory/` from `{config}/projects/<old slug>/` to the new slug's folder, or the Memory tab will be empty and overrides won't apply
- **Different config folder**: `CLAUDE_CONFIG_DIR` changes `{config}` on both platforms
- **Line endings**: CRLF is handled; no conversion needed

### Fullscreen layout

- macOS (zsh): `echo 'export CLAUDE_CODE_NO_FLICKER=1' >> ~/.zshrc`, then open a new tab
- Windows (PowerShell): `setx CLAUDE_CODE_NO_FLICKER 1`, then open a new terminal window

### Clicking buttons

- macOS Terminal.app: turn on View → "Allow Mouse Reporting" (⌘R)
- macOS iTerm2: turn on Settings → Profiles → Terminal → "Enable mouse reporting"
- Windows Terminal: works by default
- If clicks don't land, use `/board` and `/handoff`

### herdr

- macOS: herdr usually lives in `~/.local/bin/herdr`. Sessions started inside herdr use `HERDR_BIN_PATH` and don't depend on PATH; otherwise make sure `~/.local/bin` is on PATH
- Windows: `herdr.exe` must be on PATH

## Development

A marketplace added from a local folder reads that folder directly: saving a file hot-reloads running sessions — no version bump or update needed. Don't also load the same folder with `--plugin-dir`, or it loads twice.

```bash
claude plugin test
```

Users, projects and paths in the tests are fictional (`/Users/user/Projects/example-app`, `D:\work\example-app`). Tests default to macOS paths and `HOME`; `setup(on, { windows: true })` switches to Windows paths and `USERPROFILE`. The suite has been run on both macOS and Windows.

See [AGENTS.en.md](AGENTS.en.md) for architecture and contributor notes.

## License

[MIT](LICENSE)
