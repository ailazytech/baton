# 給 coding agent 的說明

[English](AGENTS.en.md) ｜ 繁體中文

這份是給接手這個 repo 的 AI agent（Claude Code、Codex 等）看的。使用者文件在 [README.md](README.md)。

## 這是什麼

session-board 是 Claude Code 的 hooks 外掛（plugin 的 `hooks/hooks.json` 指向一個 JS 模組），在側邊畫一個工作看板，並在提示快取過期前自動「寫交接 → 壓縮對話」。沒有 build 步驟、沒有 npm 相依套件。

## 檔案

| 路徑 | 內容 |
| --- | --- |
| `hooks/register.js` | 全部的程式：狀態、hook 處理、看板畫面。`export function register(on, options)` 是進入點 |
| `hooks/hooks.json` | 宣告模組 `./register.js` |
| `.claude-plugin/plugin.json` | 外掛名稱、版本、`userConfig`（`/config` 裡的設定項） |
| `.claude-plugin/marketplace.json` | 讓這個 repo 本身可以當 marketplace 加入 |
| `.claude-plugin/types/` | Claude Code 提供的型別宣告（`claude-code`、`claude-code-tools`、`claude-code-mcp`），已 gitignore，不要手改 |
| `tests/board.test.ts` | 測試，用 `claude-code/testing` 的 `test`、`mock`、`expect` |
| `README.md`／`README.en.md` | 使用者文件（中英） |

## register.js 的結構

由上往下：

1. **常數**：快取 TTL（`CACHE_TTLS`）、提前交接時間（`LEAD_MS` = 5 分鐘）、最低上下文（`MIN_CONTEXT_PERCENT` = 20）、lane 狀態順序與外觀（`LANE_ORDER`、`LANE_LOOK`）、記憶分層（`LAYERS`）
2. **模組層級的狀態**：`let` 變數（介面、執行狀態、herdr、lane、記憶、交接、`phase`）。整個外掛是一個 session 一份狀態
3. **工具函式**：路徑展開（`expandPath`、`resolvePaths`）、記憶解析（`parseMemory`）、lane（`loadLanes`、`laneStanding`…）、herdr（`parseHerdr`、`refreshHerdr`）、交接（`briefing`、`handoffPrompt`、`startHandoff`、`runCompact`、`checkTrigger`）
4. **`register(on, options)`**：註冊 hook
   - `session.start`：讀設定與資料、每秒 tick（`$.clock.every`）、註冊 `/board`、`/handoff`
   - `prompt.submit`：使用者第一個 prompt 附上 `briefing()`（`e.context`）
   - `turn.start`／`turn.step`／`turn.complete`：執行狀態、快取計時（`lastRequestAt`）、交接那一輪結束後觸發壓縮
   - `session.compact`、`classic.PostCompact`：存壓縮摘要
   - `tool.call`：記錄工具呼叫、偵測 Bash 裡的 herdr 指令
   - `ui.render`（`AbovePrompt`、`Pane`）：畫按鈕與看板
5. 看板畫面在 `ui.render { component: 'Pane' }` 裡，用 `$.ui.resolve(e)` 拿到 `Box`、`Button`、`Markdown` 等元件，依 `tab` 與 `route`（任務分頁的子頁堆疊）組出列。

### 交接狀態機

`phase`：`idle` → `handoff`（已送出 `[自動交接]` 指示）→ `compacting` → `idle`。

- `checkTrigger` 每秒跑一次，條件全部成立才 `startHandoff`：`activated`（輸入過 `/board`）、`auto`、`armed`（使用者有新動作後才重新允許）、`cacheTtl === '1h'`、剩餘時間在 0～5 分鐘、使用者沒離開超過 `away_hours`、上下文 ≥ 20%
- 只認 `turn.start` 文字裡含 `HANDOFF_PREFIX` 的那一輪是交接輪（引擎會在外掛訊息前加前綴，所以用 `includes` 不用 `startsWith`）
- 那一輪被中斷就不壓縮；`session.compact` 被拒絕（還有一輪在跑）會重試最多 6 次
- 有 `tasks_dir` 時，交接指示與 briefing 改成 lane 狀態檔版本（`laneBriefing`、`handoffPrompt` 的 `tasksDir` 分支）

## 慣例

- **語言**：程式註解、介面文字、測試名稱用繁體中文（台灣用語）。改了介面文字或行為，`README.md` 與 `README.en.md` 都要更新
- **風格**：2 格縮排、單引號、不加分號、尾隨逗號；跟周圍程式一致
- **註解**：寫「為什麼」，尤其是引擎行為的限制（例如「command.run 裡不能直接 prompt.submit」）
- **路徑**：內部一律轉成 `/` 分隔；比對用 `samePath`（不分大小寫）。新功能要同時考慮 macOS（`HOME`）與 Windows（`USERPROFILE`、磁碟代號）
- **錯誤**：讀檔失敗不要丟例外讓看板壞掉，寫到 `note` 或對應的 `*Error` 變數，在看板上顯示
- **外部指令**：只透過 `$.process.run` 呼叫 herdr；執行檔用 `herdrBin`（`HERDR_BIN_PATH` 或 `herdr`）
- **重畫**：狀態改變後呼叫 `$.ui.invalidate('ui.render')`；看板關著時 tick 不重畫
- **持久化**：跨重載要保留的值用 `$.store`，key 帶 `sessionId`（例如 `times:<id>`、`herdr:<id>`）
- **設定**：新增使用者設定要同時改 `plugin.json` 的 `userConfig`、`register()` 開頭讀 `options` 的地方、兩份 README 的設定表
- **版本**：改了行為就調 `plugin.json` 的 `version`

## 測試

```bash
claude plugin test
```

- 測試裡的人名、專案、路徑都是虛構的，不要放真實的使用者名稱或路徑
- `setup(on, { ... })` 建立檔案與環境的 stub；預設 macOS，`{ windows: true }` 改用 Windows
- 時間用 `$.clock` 控制，不要用真實時間
- 改了行為就加或改對應的測試；全部通過才算完成

## 改動前先確認

- 不確定 Claude Code hooks API 有沒有某個能力時，查 `.claude-plugin/types/claude-code/index.d.ts`，不要猜
- 會改變自動交接觸發條件、或會在使用者不知情時送出 prompt／壓縮的改動，先跟使用者確認

## 常見任務的入口

| 想做的事 | 從這裡看 |
| --- | --- |
| 改交接指示的內容 | `handoffPrompt`、`compactInstructions` |
| 改新 session 附給 Claude 的說明 | `briefing`、`laneBriefing` |
| 改觸發條件 | `checkTrigger` |
| 加 lane 欄位 | `loadLanes`（驗證）、`laneStanding`、`ui.render` 的 lane 子頁 |
| 加記憶欄位 | `parseMemory`、記憶分頁的渲染 |
| 加看板分頁 | `tabButton` 那一列、`tab` 的分支 |
