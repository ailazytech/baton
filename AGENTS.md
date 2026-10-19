# 給 coding agent 的說明

[English](AGENTS.en.md) ｜ 繁體中文

這份是給接手這個 repo 的 AI agent（Claude Code、Codex 等）看的。使用者文件在 [README.md](README.md)。

## 這是什麼

baton 是 Claude Code 的 hooks 外掛（plugin 的 `hooks/hooks.json` 指向一個 JS 模組），在側邊畫一個工作看板，並在提示快取過期前自動「寫交接 → 壓縮對話」。沒有 build 步驟、沒有 npm 相依套件。

## 檔案

| 路徑 | 內容 |
| --- | --- |
| `hooks/register.js` | 狀態、hook 處理、看板畫面、所有文字（`I18N`）。`export function register(on, options)` 是進入點 |
| `hooks/nudges.js` | 防呆提醒的判斷：連續失敗的簽名、改檔與驗證的紀錄、「完成了」的說法、回覆語言判斷。純函式 |
| `hooks/notes.js` | 自動整理筆記的判斷：解析與驗證整理模型的輸出、改寫記憶檔 frontmatter、講 3 次的候選。純函式 |
| `hooks/guards.js` | 守門的判斷：比對工具參數、起草候選、驗證模型的草稿。純函式 |
| `hooks/hooks.json` | 宣告模組 `./register.js`（其他三個由它 import） |
| `.claude-plugin/plugin.json` | 外掛名稱、版本、`userConfig`（`/config` 裡的設定項） |
| `.claude-plugin/marketplace.json` | 讓這個 repo 本身可以當 marketplace 加入 |
| `.claude-plugin/types/` | Claude Code 提供的型別宣告（`claude-code`、`claude-code-tools`、`claude-code-mcp`），已 gitignore，不要手改 |
| `tests/board.test.ts` | 整合測試，用 `claude-code/testing` 的 `test`、`mock`、`expect` |
| `tests/logic.test.ts` | `nudges.js`、`notes.js`、`guards.js` 的純函式測試 |
| `README.md`／`README.en.md` | 使用者文件（中英） |

## register.js 的結構

由上往下：

1. **常數**：快取 TTL（`CACHE_TTLS`）、提前交接時間（`LEAD_MS` = 5 分鐘）、最低上下文（`MIN_CONTEXT_PERCENT` = 20）、lane 狀態順序與外觀（`LANE_ORDER`、`LANE_LOOK`）、記憶分層（`LAYERS`）、所有介面與提示文字（`I18N`）
2. **模組層級的狀態**：`let` 變數（介面、執行狀態、herdr、lane、記憶、交接、`phase`）。整個外掛是一個 session 一份狀態
3. **工具函式**：路徑展開（`expandPath`、`resolvePaths`）、記憶解析（`parseMemory`）、lane（`loadLanes`、`laneStanding`…）、herdr（`parseHerdr`、`refreshHerdr`）、交接（`briefing`、`handoffPrompt`、`startHandoff`、`runCompact`、`checkTrigger`）
4. **`register(on, options)`**：註冊 hook
   - `session.start`：讀設定與資料、每秒 tick（`$.clock.every`）、註冊 `/board`、`/handoff`、`/distill`、`/guard`
   - `prompt.submit`：使用者第一個 prompt 附上 `briefing()`、講 3 次的要求（`T.promote`）、待問的守門（`T.guardAsk`）；每則使用者訊息記進整理筆記用的對話紀錄（`recordTalk`），並帶出上一輪的回覆語言提醒
   - `turn.start`／`turn.step`／`turn.complete`：執行狀態、快取計時（`lastRequestAt`）、交接那一輪結束後觸發壓縮；`turn.step` 判斷回覆語言，`turn.complete` 記下回答、每 `distill_every` 則訊息觸發整理
   - `classic.Stop`：說完成了卻沒驗證時回 `block`（`doneCheck`）
   - `session.compact`、`classic.PostCompact`：存壓縮摘要
   - `tool.call`：守門比對（`findGuardHit`，deny 直接回 `deny`）、記錄工具呼叫、防呆觀察（`watchCall`：連續失敗、改檔與驗證）、偵測 Bash 裡的 herdr 指令、改了記憶／守門檔就重讀
   - `ui.render`（`AbovePrompt`、`Pane`）：畫按鈕與看板
5. 看板畫面在 `ui.render { component: 'Pane' }` 裡，用 `$.ui.resolve(e)` 拿到 `Box`、`Button`、`Markdown` 等元件，依 `tab` 與 `route`（任務分頁的子頁堆疊）組出列。

### 交接狀態機

`phase`：`idle` → `handoff`（已送出交接指示，開頭是目前語言的 `handoffPrefix`）→ `compacting` → `idle`。

- `checkTrigger` 每秒跑一次，條件全部成立才 `startHandoff`：`activated`（輸入過 `/board`）、`auto`、`armed`（使用者有新動作後才重新允許）、`cacheTtl === '1h'`、剩餘時間在 0～5 分鐘、使用者沒離開超過 `away_hours`、上下文 ≥ 20%
- 只認 `turn.start` 文字裡含 `HANDOFF_PREFIX` 的那一輪是交接輪（引擎會在外掛訊息前加前綴，所以用 `includes` 不用 `startsWith`）
- 那一輪被中斷就不壓縮；`session.compact` 被拒絕（還有一輪在跑）會重試最多 6 次
- 有 `tasks_dir` 時，交接指示與 briefing 改成 lane 狀態檔版本（`laneBriefing`、`handoffPrompt` 的 `tasksDir` 分支）
- `startHandoff` 會順便觸發一次整理筆記（另一個 `$.model.complete` 請求，不佔主對話）

### 自動整理筆記與守門

- 對話紀錄（`talk`）依專案存在 `$.store` 的 `talk:<專案代號>`（不是依 session：換 session 後沒整理到的要接著整理）：只有使用者親手打的訊息（`prompt.submit` 的 `composer`／`bridge`，斜線指令除外）與主對話的回答。整理成功才丟掉送出去的那段；失敗留著下次再送
- 整理模型的輸出每條都要附 `quote`，`parseActions` 會拿去比對使用者打過的訊息，對不上就丟掉。這是防止模型把 Claude 的話或自己的推論記成使用者的要求，不要拿掉
- 記憶檔只改 frontmatter 的 `metadata`（`setMeta`），內文不動；新增的記憶 `metadata.source: baton`
- 守門存在 `{config}/projects/{project}/baton-guards.json`。使用者同意由 Claude 直接改檔（`tool.call` 看到這個檔被寫就重讀），不需要另外的指令
- `tool.call` 是會擋住工具的 hook：裡面新加的東西一律 `try`／`catch`，出錯就放行

## 慣例

- **介面語言**：使用者看得到的文字（看板、toast、指令說明）和送給 Claude 或整理模型的文字（briefing、交接指示、壓縮指示、防呆提醒、整理與守門的提示）一律放在 `I18N`，用 `T.xxx` 取用，不要在程式裡寫死字串。新增一項就要同時補 `zh-TW` 和 `en`。語言在 `session.start` 由 `detectLanguage` 決定。唯一的例外是 `nudges.js` 的回覆語言提醒：它要用「目標語言」寫（繁中、簡中、英、日），和介面語言無關。`nudges.js`、`notes.js`、`guards.js` 只放判斷邏輯，被丟掉的原因用英文短句、不翻譯（只拿來計數與除錯）
- **文件**：改了介面文字或行為，`README.md` 與 `README.en.md` 都要更新；程式註解與測試名稱目前用繁體中文
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
| 改交接指示的內容 | `I18N` 的 `handoffHead`、`handoffLane`、`handoffDocSteps`、`compactLane`、`compactDoc` |
| 改新 session 附給 Claude 的說明 | `I18N` 的 `briefing`、`laneBriefing`、`promote`、`guardAsk` |
| 改防呆提醒 | 判斷在 `nudges.js`；文字在 `I18N` 的 `retryNudge`、`doneCheck` |
| 改整理筆記記什麼 | `I18N` 的 `distillPrompt`；驗證在 `notes.js` 的 `parseActions` |
| 改守門的起草與比對 | `I18N` 的 `guardPrompt`；比對與驗證在 `guards.js` |
| 加一種介面語言 | `I18N` 加一組、`detectLanguage`、`plugin.json` 的 `language` 選項 |
| 改觸發條件 | `checkTrigger` |
| 加 lane 欄位 | `loadLanes`（驗證）、`laneStanding`、`ui.render` 的 lane 子頁 |
| 加記憶欄位 | `parseMemory`、記憶分頁的渲染 |
| 加看板分頁 | `tabButton` 那一列、`tab` 的分支 |
