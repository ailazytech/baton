# baton

[English](README.en.md) ｜ 繁體中文

Claude Code 的側邊工作看板（hooks 外掛）。在提示快取過期前**自動寫交接、再壓縮對話**，讓長時間的工作不會因為快取過期或上下文爆掉而斷線；同時把多條並行工作線（lane）、分層記憶、herdr 指揮的 agent 集中在一個面板上。

> 需要 Claude Code **2.1.287 以上**（測試版本 2.1.288）。macOS 與 Windows 共用同一份程式。

## 它解決什麼問題

用 Claude Code 做長時間的工作（一整個下午的重構、同時派好幾個 agent 跑不同的線），通常會卡在這幾件事：

- **離開一下回來，快取就過期了**：提示快取預設 1 小時。開會、吃飯回來，下一輪要把整段對話重新算一次，又慢又花錢；對話越長越痛。
- **上下文滿了被迫壓縮，壓完不知道做到哪**：自動壓縮發生在最不方便的時候，摘要也不一定留住你在意的細節（下一步是什麼、哪個決定還在等你）。
- **開新 session 等於失憶**：要自己把交接文件貼回去，或花好幾輪重新解釋背景。
- **多條線同時跑，不知道誰在等你**：好幾個 agent 各跑一條線，有的卡在權限對話框、有的做完等驗收、有的失敗了，你得一個一個 pane 切過去看。

baton 的做法：

- **快取剩 5 分鐘時主動交接**：叫 Claude 先把目標、進度、下一步、待決定的事寫進交接文件，再自動壓縮。交接趁快取還沒過期時做，這一輪本身很便宜；之後從乾淨的上下文接續。
- **新 session／壓縮後自動補上下文**：第一個 prompt 自動附上交接文件，不用自己貼。
- **一個面板看所有工作線**：每條 lane 一個 JSON 狀態檔，「等你」「失敗」「待審」排最前面並跳通知；點進去看即時畫面、送按鍵、直接回覆，不用切 pane。
- **記憶分層**：使用者偏好、專案事實、某條線的細節、會過期的階段資訊分開放，過期的會提醒你檢查。

## 快速開始

```bash
claude update                                          # 確認 2.1.287 以上
claude plugin marketplace add ailazytech/baton   # 或本機路徑
claude plugin install baton@baton
```

開新的 session，輸入 `/board`。

- `/board`：開關看板。**輸入過 `/board` 的 session 才會啟用自動交接**（當作主控 session）。
- `/handoff`：立即交接，不用開看板。非全螢幕時滑鼠點不到看板按鈕，就用這個。
- 看板關著時，輸入框上方右側有一顆「◧ 工作看板」按鈕（`/config` 的 `launcher_button` 可關）。

看板要停靠在右側，需要全螢幕版面（`CLAUDE_CODE_NO_FLICKER=1`）且終端至少 110 欄；否則放在輸入框上方。

## 功能

### 分頁

- **任務**（專案設了 `tasks_dir` 才出現，見「lane 狀態檔」）：每條 lane 一到兩行＋百分比，要處理的（等你、失敗、待審、對話框等確認）排最前，待命與完成的收起來
  - 點一條 lane 進子頁：步驟、等你決定的事、備註、即時畫面（`herdr pane read`，每 3 秒更新）、按鍵（Enter／Esc／1／2／3）、回覆輸入框（`herdr agent prompt`）、報告、這條線的記憶
  - 報告是再下一層子頁；「← 返回」一層層退回，回到列表時捲回剛才那一列
  - 別的 lane 變成等你、待審、失敗時跳通知
- **記憶**：依 frontmatter 的 `metadata.layer` 分成使用者／專案／工作線／階段；工作線的記憶用 `metadata.lane` 掛到 lane 子頁，階段記憶過了 `metadata.review_by` 會標「該檢查了」；沒標 layer 的歸「未分層」，依類型分組
- **進度**（有任務分頁時叫「交接」）：執行狀態、任務、上下文用量、交接文件
- **Herdr**（在 herdr 裡、且沒有任務分頁時才出現）：這個 session 透過 herdr 指揮過的 agent／pane 與即時狀態，blocked 或 done 時跳通知
- **底部**：目前模型、快取倒數、自動交接開關

### 自動交接的流程

1. 主控 session 每次送出請求，快取就重新計時。
2. 快取剩 5 分鐘、且符合以下條件時，外掛送出一則以 `[自動交接]` 開頭的指示，要 Claude 更新交接文件（或自己的 lane 狀態檔）與記憶：
   - 這個 session 輸入過 `/board`，且自動交接開著
   - `cache_ttl` 是 `1h`（5 分鐘的快取不自動交接，否則一直被打斷）
   - 上下文用量至少 20%（太小不值得壓縮）
   - 最後一次輸入在 `away_hours` 以內，或 Claude 還在跑
3. 交接那一輪結束後自動壓縮對話；摘要存到交接文件旁的 `*.compact.md`，看板「壓縮後保留」可展開。
4. 壓縮後的第一個 prompt，再把交接文件附給 Claude（`/config` 的 `brief_on_start` 可關）。還沒設 `tasks_dir` 的專案會多附一段，請 Claude 遇到多條並行工作時問你要不要開「任務」分頁。

## 設定

在 `/config` 可以改：

| 設定 | 說明 | 預設 |
| --- | --- | --- |
| `memory_dir` | 記憶資料夾 | `{config}/projects/{project}/memory` |
| `handoff_path` | 交接文件 | `docs/HANDOFF.md` |
| `brief_on_start` | 新 session／壓縮後自動附上交接文件 | 開 |
| `launcher_button` | 輸入框上方的看板按鈕 | 開 |
| `cache_ttl` | 提示快取時效 `1h`／`5m`；切換模型時以引擎告知的值為準 | `1h` |
| `away_hours` | 最後一次輸入超過幾小時就不再自動交接（`24`／`8`／`2`） | `24` |

路徑可用 `{config}`（`~/.claude` 或 `CLAUDE_CONFIG_DIR`）、`{project}`（專案代號）、`{root}`（專案根目錄）、`~`；相對路徑以專案根目錄為準。

### 個別專案覆寫

在 `{config}/projects/{project}/baton.json`（不放進專案 repo）覆寫這個專案的設定，存檔後自動重讀。沒有 `baton.json` 時，會讀改名前的 `session-board.json`：

```json
{
  "handoff_path": "docs/migration/PROGRESS.md",
  "handoff_section": "## 交接"
}
```

- `handoff_path`、`memory_dir`：同上
- `handoff_section`：交接文件是專案自己的文件時設定。看板與新 session 只讀第一個以此開頭的標題那一節；自動交接只要求更新那一節，不整份覆寫
- `compact_path`：壓縮摘要位置，預設放在全域 `handoff_path` 旁邊（不會因為改用專案文件而寫進 repo）
- `tasks_dir`：lane 狀態檔資料夾，設了就有「任務」分頁
- `tasks_self`：主控 session 自己的狀態檔名（預設 `architect`）

### lane 狀態檔

`tasks_dir` 裡每條 lane 一個 `<lane>.json`：

```json
{
  "lane": "api",
  "title": "把 REST API 改成分頁回傳",
  "state": "working",
  "steps": [
    { "id": "S1", "title": "盤點現有端點", "state": "done" },
    { "id": "S2", "title": "加上 cursor 參數", "state": "doing" },
    { "id": "S3", "title": "補測試", "state": "todo" }
  ],
  "updated": "2026-10-16T09:30:00Z",
  "notes": ["舊 client 仍用 offset，先保留相容"]
}
```

- 必填：`lane`、`title`（一行）、`state`（`blocked`／`failed`／`review`／`working`／`idle`／`done`）、`steps`（`{ id, title, state: todo|doing|done|skip }`）、`updated`
- 選填：`needs`（等使用者決定的事）、`pane`（herdr pane id）、`spec`、`head`、`report`（報告檔路徑）、`notes`
- 百分比＝完成步驟 ÷（總數 − 跳過）
- 專案自己的規則與驗證工具寫在該資料夾的 README

有 `tasks_dir` 時，交接改成「狀態檔」模式：

- 新 session 或壓縮後的第一個 prompt 只附任務一覽與主控自己的步驟、備註；詳細交接文件只給路徑，需要時再讀
- 自動交接要求更新主控自己的狀態檔（steps、needs、notes），不再重寫交接文件

### 記憶檔格式

記憶資料夾裡每個 `.md` 一則（`MEMORY.md` 是索引，不列出）：

```markdown
---
name: no-hotkeys
description: 看板不要用快捷鍵
metadata:
  type: feedback        # user / feedback / project / reference
  layer: user           # user / project / workstream / phase
  lane: api             # layer 是 workstream 時，掛到哪條 lane
  review_by: 2026-11-01 # layer 是 phase 時，過了這天標「該檢查了」
---

不要幫我用快捷鍵。
```

## 讓 AI agent 接手

這個 repo 根目錄的 [AGENTS.md](AGENTS.md)（英文 [AGENTS.en.md](AGENTS.en.md)）是給 coding agent 的說明：架構、慣例、測試、改動時要注意的地方。Claude Code 會透過 `CLAUDE.md` 自動讀到。

可以直接貼給 agent 的提示：

**改這個外掛**

```text
先讀 AGENTS.md，再讀 hooks/register.js 裡跟這次要改的功能相關的段落。
我要改：<描述>。
改完跑 `claude plugin test`，全部通過再回報；行為有變就同步更新 README.md 與 README.en.md。
```

**在自己的專案開「任務」分頁**

```text
我想用 baton 的任務分頁管理這個專案的並行工作。
請在 ~/.claude/projects/<專案代號>/baton.json 設定 tasks_dir 指向 <資料夾>，
在那個資料夾建一份 README 寫清楚 lane 狀態檔的格式與更新規則，
再為目前進行中的工作各建一個 <lane>.json，主控自己的叫 architect.json。
```

**接續別人留下的交接**

```text
讀 <交接文件路徑>（和 tasks_dir 裡的狀態檔，如果有的話），
用三到五行告訴我目前的目標、做到哪、下一步，以及有沒有在等我決定的事。先不要動手。
```

## macOS 與 Windows

外掛內部的路徑一律轉成 `/` 分隔，兩邊用同一份程式。

### 路徑與資料夾

| 項目 | macOS | Windows |
| --- | --- | --- |
| 家目錄（`~`） | `HOME`，例如 `/Users/<名稱>` | `USERPROFILE`，例如 `C:\Users\<名稱>` |
| `{config}` 預設 | `/Users/<名稱>/.claude` | `C:\Users\<名稱>\.claude` |
| 絕對路徑 | 從 `/` 開始 | 從磁碟代號開始（`D:/...`） |
| `{project}` 代號 | `/Users/<名稱>/Projects/app` → `-Users-<名稱>-Projects-app` | `D:\work\app` → `D--work-app` |
| 檔名大小寫 | APFS 預設不分（外掛比對路徑時不分大小寫） | NTFS 不分 |

- **專案設定寫相對路徑**：`baton.json` 裡的 `handoff_path`、`tasks_dir`、`compact_path`，以及 lane 狀態檔的 `report`、`spec`，都寫相對於專案根目錄的路徑，兩邊都能用
- **要寫絕對路徑時**：macOS 用 `~/...`；Windows 用 `/` 分隔（`D:/notes`）。JSON 裡的反斜線要跳脫成 `D:\\notes`，用 `/` 比較不會出錯
- **換電腦時搬專案資料**：`{project}` 代號跟著專案路徑變。舊電腦 `{config}/projects/<舊代號>/` 底下的 `baton.json` 和 `memory/` 要複製到新代號的資料夾，否則記憶分頁是空的、專案覆寫也不會生效
- **換設定資料夾**：兩邊都可以用 `CLAUDE_CONFIG_DIR` 改 `{config}`
- **換行字元**：CRLF 讀得懂，不用轉

### 全螢幕版面

- macOS（zsh）：`echo 'export CLAUDE_CODE_NO_FLICKER=1' >> ~/.zshrc`，開新的終端分頁後生效
- Windows（PowerShell）：`setx CLAUDE_CODE_NO_FLICKER 1`，開新的終端視窗後生效

### 滑鼠點按鈕

- macOS Terminal.app：View 選單的「Allow Mouse Reporting」（⌘R）要打開
- macOS iTerm2：Settings → Profiles → Terminal 的「Enable mouse reporting」要打開
- Windows Terminal：預設就會傳
- 點不到的時候改用 `/board`、`/handoff`

### herdr

- macOS：herdr 通常裝在 `~/.local/bin/herdr`。在 herdr 裡開的 session 會用 `HERDR_BIN_PATH`，不靠 PATH；不是在 herdr 裡開的，要確認 `~/.local/bin` 在 PATH 上
- Windows：`herdr.exe` 要在 PATH 上

## 開發

從本機資料夾加入的 marketplace，安裝版直接讀這個資料夾，存檔後執行中的 session 會自動重載，不用改版本號或跑 update。不要再同時用 `--plugin-dir` 載入同一個資料夾，否則會載入兩份。

```bash
claude plugin test
```

測試裡的使用者、專案與路徑都是虛構的（`/Users/user/Projects/example-app`、`D:\work\example-app`）。預設用 macOS 的路徑與 `HOME`，`setup(on, { windows: true })` 改用 Windows 的路徑與 `USERPROFILE`。macOS 與 Windows 都實測過。

架構與貢獻須知見 [AGENTS.md](AGENTS.md)。

## 授權

[MIT](LICENSE)
