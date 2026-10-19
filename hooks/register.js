// baton：側邊工作看板（原名 session-board）
// 分頁「任務」（專案設了 tasks_dir 時）：每條 lane 一到兩行＋百分比，點開是 lane 的子頁（步驟、即時畫面、回覆、報告、記憶），可返回原位
// 分頁「進度／交接」：執行狀態、任務清單、上下文用量、交接文件
// 分頁「記憶」：本專案的記憶檔，依 layer 分層（使用者／專案／工作線／階段）
// 底部：提示快取倒數；快取快過期時自動寫交接（狀態檔或交接文件），寫完後觸發壓縮
// 防呆提醒（nudges.js）：同樣的失敗連續兩次、說完成了卻沒驗證、回覆語言跑掉時，給 Claude 一句提醒
// 自動整理筆記（notes.js）：每 N 則使用者訊息、交接前或 /distill 時，用便宜的模型把使用者的要求與糾正寫進記憶資料夾；講 3 次以上請 Claude 放進專案
// 守門（guards.js）：寫成文字還一再被違反的要求，起草成工具呼叫前的比對，使用者同意才生效

import { briefOf, doneCheck, freshReply, freshWork, noteCall, noteStep, replyLangOfSetting, takeNext, takePending, trackFailure } from './nudges.js'
import { ACTIONS_END, ACTIONS_START, ASSISTANT_MAX, PROMOTE_COUNT, USER_MAX, indexLine, newMemoryFile, parseActions, promoteCandidates, setMeta, squash } from './notes.js'
import { GUARDS_END, GUARDS_START, GUARD_ASK_ITEMS, GUARD_MIN_COUNT, PATTERN_MAX, applyGuardChange, findGuardHit, guardCandidates, parseGuards, withProposals } from './guards.js'

const PANE = 'baton'

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
// 提示快取 TTL：預設 1 小時，超量時降為 5 分鐘（/config 的 cache_ttl，或切換模型時引擎告知的值）
const CACHE_TTLS = { '1h': HOUR, '5m': 5 * MINUTE }
// 剩下多少時間時開始交接（要留時間給交接那一輪開始；那一輪本身會重新寫入快取）
const LEAD_MS = 5 * MINUTE
// 上下文低於此百分比就不值得壓縮
const MIN_CONTEXT_PERCENT = 20
// 下過 herdr 指令後這段時間內持續查狀態（對方可能還沒進入 working）
const HERDR_GRACE_MS = 60 * 1000
// 路徑預設值；可在 /config 或 settings 的 pluginConfigs 覆寫（見 plugin.json 的 userConfig）
// 可用 {config}（~/.claude 或 CLAUDE_CONFIG_DIR）、{project}（專案資料夾代號）、{root}（專案根目錄）、~
// 相對路徑以專案根目錄為準
const DEFAULT_MEMORY_DIR = '{config}/projects/{project}/memory'
const DEFAULT_HANDOFF_PATH = 'docs/HANDOFF.md'
// 每個專案的覆寫檔（不放進專案 repo）：{ handoff_path, handoff_section, compact_path, memory_dir, tasks_dir, tasks_self }
const PROJECT_SETTINGS = '{config}/projects/{project}/baton.json'
// 改名前（session-board）的覆寫檔：沒有 baton.json 時退回讀這個，舊專案不用搬
const LEGACY_PROJECT_SETTINGS = '{config}/projects/{project}/session-board.json'
// 守門（不放進專案 repo）：[{ id, rule, tool, match, unless?, mode, message, state, bad, good, at }]
const GUARDS_FILE = '{config}/projects/{project}/baton-guards.json'
// 整理筆記的對話紀錄最多留幾則（整理失敗一直重試時不會無限長大）
const TALK_MAX = 400

// lane 狀態檔（tasks_dir 底下每條 lane 一個 <lane>.json）；順序＝顯示順序，要人處理的在前
const LANE_ORDER = ['blocked', 'failed', 'review', 'working', 'idle', 'done']
// 圖示與顏色；文字在 I18N 的 laneStates
const LANE_LOOK = {
  blocked: ['⚠', 'red'],
  failed: ['✖', 'red'],
  review: ['✔', 'yellow'],
  working: ['◐', 'green'],
  idle: ['○', undefined],
  done: ['✓', undefined],
}
const STEP_ICONS = { done: '✔', doing: '◐', todo: '○', skip: '–' }
// 進行中的 lane 這麼久沒更新狀態檔，就提示可能停住了
const STALE_MS = 30 * MINUTE
// 即時畫面：平常顯示幾行、展開顯示幾行
const SCREEN_ROWS = 14
const SCREEN_ROWS_LONG = 45
// 子頁裡送給 lane 的按鍵（回應權限對話框之類）
const LANE_KEYS = [
  ['enter', 'Enter'],
  ['esc', 'Esc'],
  ['1', '1'],
  ['2', '2'],
  ['3', '3'],
]

// 記憶分層（frontmatter 的 metadata.layer）；沒標的歸「未分層」。文字在 I18N 的 layers
const LAYERS = ['user', 'project', 'workstream', 'phase']
// 沒分層的記憶依 metadata.type 分組；文字在 I18N 的 types
const MEMORY_TYPES = ['feedback', 'user', 'project', 'reference']

// 介面、交接指示與給 Claude 的說明都跟著使用者語言（/config 的 language；auto 依 Claude Code 的 language 設定或 LANG）
const I18N = {
  'zh-TW': {
    handoffPrefix: '[自動交接]',
    paneTitle: '工作看板',
    launcher: '◧ 工作看板',
    cmdBoard: '開關工作看板（進度／記憶／快取倒數）',
    cmdHandoff: '立即交接：寫交接文件後壓縮對話（等同看板的「立即交接」）',
    registerFail: (name, err) => '註冊 /' + name + ' 失敗：' + err,
    laneStates: { blocked: '等你', failed: '失敗', review: '待審', working: '進行中', idle: '待命', done: '完成' },
    layers: {
      user: ['使用者', '你的偏好與做法，每次都帶'],
      project: ['專案', '長期不變的事實與決定'],
      workstream: ['工作線', '跟著某條 lane'],
      phase: ['階段', '目前這一段，會過期'],
      none: ['未分層', '還沒標 layer'],
    },
    types: { feedback: '叮囑', user: '關於你', project: '專案', reference: '參考', other: '其他' },
    herdrActions: {
      prompt: '派工作',
      'send-keys': '送按鍵',
      read: '讀輸出',
      wait: '等待',
      focus: '切換焦點',
      start: '啟動 agent',
      split: '分割出新 pane',
      run: '執行指令',
      'send-text': '送文字',
      close: '關閉',
    },
    // 時間
    justNow: '剛剛',
    minutesAgo: (n) => n + ' 分鐘前',
    hoursAgo: (n) => n + ' 小時前',
    // lane
    dialogWaiting: '對話框等確認',
    waitingOn: (needs) => '等你：' + needs,
    failed: (detail) => '失敗' + (detail ? '：' + detail : ''),
    failedAt: (step) => '失敗於 ' + step,
    reviewDone: '做完待審',
    running: (d) => '● 執行中 ' + d,
    stale: (ago) => ago + '沒更新',
    idle: '待命',
    accepted: '已驗收',
    noTasksDir: '找不到任務資料夾',
    unreadable: (names) => '讀不懂：' + names.join('、'),
    lanesReadFail: (err) => '讀取任務失敗：' + err,
    toastBlocked: (lane, needs) => lane + ' 等你：' + needs,
    toastReview: (lane) => lane + ' 做完了，等驗收',
    toastFailed: (lane) => lane + ' 失敗',
    screenFail: (err) => '讀不到畫面：' + err,
    sendFail: (err) => '沒送出：' + err,
    sentTo: (lane) => '已送給 ' + lane,
    keyFail: (err) => '按鍵沒送出：' + err,
    reportMissing: '報告檔不存在',
    reportFail: (err) => '讀不到報告：' + err,
    // 檔案
    settingsReadFail: (err) => '讀取專案設定失敗：' + err,
    compactWriteFail: (err) => '寫入壓縮摘要失敗：' + err,
    memoryReadFail: (err) => '讀取記憶失敗：' + err,
    // herdr
    herdrReadFail: (err) => '讀取 herdr 失敗：' + err,
    herdrBlocked: (who) => who + ' 在等待確認',
    herdrDone: (who) => who + ' 已完成',
    // 交接
    handoffToast: '快取即將過期，開始寫交接文件',
    handoffSent: '已送出交接指示',
    handoffBlocked: (why) => '交接指示被擋下：' + why,
    handoffSubmitFail: (err) => '交接指示送出失敗：' + err,
    alreadyHandingOff: '已經在交接中',
    alreadyCompacting: '正在壓縮中',
    compactSkipped: (why) => '壓縮被略過：' + why,
    compactDone: '交接完成並已壓縮',
    compactFail: (err) => '壓縮失敗：' + err,
    contextTooSmall: (p) => '上下文只有 ' + p + '%，略過自動交接',
    handoffAborted: '交接那一輪被中斷，本次不壓縮',
    handoffWritten: '交接文件已寫好，準備壓縮',
    // 看板：進度
    runningTools: (d, n) => '● 執行中 ' + d + ' · 本輪工具 ' + n + ' 次',
    idleState: '○ 閒置',
    context: (p) => '上下文 ' + p + '%',
    tasksHeader: (done, total) => '任務 ' + done + '/' + total,
    lastReply: '上一輪回覆',
    compactKept: (at) => '壓縮後保留（' + at + '）',
    handoffDoc: (at) => '交接文件（' + at + '）',
    onlySection: (s) => ' · 只讀「' + s + '」一節',
    noHandoff: '尚無交接文件',
    // 看板：記憶
    dueReview: ' ⚠ 該檢查了',
    dueReviewN: (n) => ' ⚠ ' + n + ' 則該檢查了',
    memoryCount: (n) => n + ' 則記憶',
    refresh: '重新整理',
    noMemories: '這個資料夾還沒有記憶。',
    // 看板：任務
    back: '← 返回',
    tasks: '任務',
    noLanes: '還沒有 lane 狀態檔。',
    needsYou: (n) => '需要處理 ' + n,
    working: (n) => '進行中 ' + n,
    quiet: (idle, done) => '待命 ' + idle + ' · 已完成 ' + done,
    otherAgents: (n) => '其他 agent（沒有狀態檔）' + n,
    updated: (ago) => '更新 ' + ago,
    spec: '規格 ',
    decide: '等你決定',
    notes: '備註',
    liveScreen: '即時畫面',
    loading: '讀取中…',
    less: '少一點',
    more: '多一點',
    keys: '按鍵',
    dialogPlaceholder: '對話框在等確認，先用上面的按鍵',
    replyPlaceholder: (lane) => '回覆 ' + lane + '…',
    send: '送出',
    report: '報告',
    laneMemories: (n) => '這條線的記憶（' + n + '）',
    laneGone: '這條 lane 的狀態檔不見了。',
    // 看板：Herdr
    notAgent: '已結束或不是 agent pane',
    thisPane: (id) => '本 pane ' + id,
    commanded: (n) => '這個 session 指揮的（' + n + '）',
    noCommanded: '還沒有透過 herdr 指揮其他 pane。',
    lastAction: (action, detail, ago) => '最後：' + action + (detail ? '「' + detail + '」' : '') + ' · ' + ago,
    sameWorkspace: (n) => '同工作區的其他 agent（' + n + '）',
    // 看板：底部
    cache: '快取',
    cacheNotYet: '尚未建立',
    cacheExpired: (d) => '已過期 ' + d + ' 前',
    handingOff: '交接中…',
    compacting: '壓縮中…',
    ttlNoAuto: (ttl) => '快取 ' + ttl + '，不自動交接',
    standby: '待命',
    doneWaiting: '已完成，等新指示',
    model: (m) => '模型 ' + m,
    autoHandoff: '自動交接',
    handoffNow: '立即交接',
    // 分頁
    tabMemory: (n) => '記憶 (' + n + ')',
    tabHandoff: '交接',
    tabProgress: '進度',
    wrap: '換行',
    count: (label, n) => label + '（' + n + '）',
    // 給 Claude 的說明（使用者看不到）
    laneBriefing: (c) => [
      '[baton] 這個專案用 lane 狀態檔交接：',
      '- 任務狀態：' + c.tasksDir + '/<lane>.json，一條 lane 一個；你自己的是 ' + c.selfLane + '.json。格式與更新規則見該資料夾的 README。',
      '- 詳細交接：' + c.handoffFile + (c.handoffSection ? ' 的「' + c.handoffSection + '」一節' : '') + '，需要細節時再讀。',
      '- 記憶：' + c.memoryDir + '（frontmatter 的 metadata.layer 分成 user／project／workstream／phase）',
      '- 主控 session 的提示快取快過期時，會要求你更新自己的狀態檔，接著自動壓縮對話。',
      '',
      '任務一覽（若和使用者這次的要求無關，可以忽略）：',
    ],
    laneLine: (lane, title, percent, done, total, standing) => lane + '：' + title + ' ' + percent + '%（' + done + '/' + total + '）· ' + standing,
    laneSelfSteps: (lane) => '你自己的步驟（' + lane + '）：',
    laneSelfNeeds: (needs) => '等使用者決定：' + needs,
    briefing: (c) => [
      '[baton] 這個專案使用 baton 交接機制：',
      '- 交接文件：' +
        c.handoffFile +
        (c.handoffSection ? ' 的「' + c.handoffSection + '」一節（專案自己的文件，只更新這一節）' : '') +
        (c.handoffAt ? '（最後更新 ' + c.handoffAt + '）' : '（尚未建立）'),
      '- 壓縮摘要：' + c.compactFile,
      '- 記憶資料夾：' + c.memoryDir,
      '- 主控 session 的提示快取快過期時，會要求你更新交接文件，接著自動壓縮對話。',
      '- 這個專案還沒開「任務」分頁。如果工作有多條並行的線（派工給 herdr、有待派工清單、交接裡同時好幾項進行中），找適當時機問使用者要不要建立；不要自己建。',
      '  建法：在 ' +
        c.projectSettingsFile +
        ' 寫 {"tasks_dir": "<資料夾>"}，資料夾裡每條 lane 一個 <lane>.json：lane、title（一行）、state（blocked／failed／review／working／idle／done）、steps（{ id, title, state: todo|doing|done|skip }）、updated，選填 needs、pane、spec、head、report、notes；主控自己那條叫 ' +
        c.selfLane +
        '.json。',
    ],
    briefingHandoff: '以下是目前的交接文件，請據此接續先前的工作；若和使用者這次的要求無關，可以忽略。',
    handoffHead: (min) => '提示快取約 ' + min + ' 分鐘後過期，接下來會自動壓縮對話。請立刻：',
    handoffLane: (c) => [
      '1. 覆寫你自己的狀態檔 `' + c.tasksDir + '/' + c.selfLane + '.json`：steps 的狀態照實更新；要使用者決定的事寫 needs；接手需要知道、但不屬於任何步驟的事寫 notes（最多 8 則，一行一則）。依該資料夾 README 的規則驗證，並更新它說要產生的總覽。',
      '2. 你驗收過或確認過狀態改變的 lane，也更新它們的狀態檔。',
      '3. 若有值得長期保存的使用者叮囑或專案事實，順手更新記憶（`' + c.memoryDir + '`，標上 metadata.layer）。',
      '4. 不要開始新的工作。寫完用一兩句回報即可。',
    ],
    handoffDocSteps: (c) => [
      (c.handoffSection
        ? '1. 更新 `' + c.handoffFile + '` 中目前的「' + c.handoffSection + '」那一節（這是專案自己的文件：依它既有的格式與慣例更新，不要整份覆寫、不要動其他章節）：'
        : '1. 把目前的處理進度寫進 `' + c.handoffFile + '`（整份覆寫、精簡）：') + '目標、已完成、進行中、下一步、關鍵檔案與決策、待使用者確認的問題。',
      '2. 若有值得長期保存的使用者叮囑或專案事實，順手更新記憶（`' + c.memoryDir + '`）。',
      '3. 不要開始新的工作。寫完用一兩句回報即可。',
    ],
    compactLane: (dir) => '保留 ' + dir + ' 的 lane 狀態檔所指的進度、等待使用者決定的事與下一步；壓縮後以狀態檔為準繼續工作。',
    compactDoc: (file, section) => '保留 ' + file + (section ? ' 的「' + section + '」一節' : '') + ' 的重點、目前任務狀態與下一步；壓縮後以交接文件為準繼續工作。',
    // 防呆提醒（給 Claude，使用者看不到）
    retryNudge: (tool, brief) =>
      '[baton] 這個工具（' + tool + '）連續兩次因同樣原因失敗（' + (brief || '沒有錯誤文字') + '）。錯誤看起來是暫時性的（逾時、還在載入、連線中斷）就稍等再試一次；不是的話先找出原因並換一個做法，不要原樣重試。',
    doneCheck: {
      unverified: '[baton] 你說完成了，但這一輪改了檔案之後沒有跑任何測試或檢查。請跑和這次改動相關的測試或檢查，在回覆附上跑了什麼、結果如何；沒辦法驗證的，說明哪些沒驗證、為什麼，不要說完成。',
      failed: '[baton] 你說完成了，但這一輪改檔後的測試或檢查沒有通過。請修好問題並重新跑過測試或檢查，在回覆附上結果；若無法修好或與這次改動無關，請在回覆誠實說明失敗原因，不要直接說完成。',
    },
    // 自動整理筆記
    cmdDistill: '立即整理筆記：把上次整理之後你的要求與糾正寫進記憶資料夾',
    distillWhy: { manual: '手動', handoff: '交接前', every: (n) => '每 ' + n + ' 則訊息' },
    distillOff: '自動整理筆記已關閉（/config 的 distill）',
    distillBusy: '正在整理筆記',
    distillStarted: (n) => '開始整理筆記（' + n + ' 則新訊息）',
    distillNothing: '上次整理之後沒有新的對話',
    distillRunning: (why) => '整理筆記中（' + why + '）',
    distillDone: (added, confirmed) => '筆記整理完：新增 ' + added + '、加次數 ' + confirmed,
    distillFail: (err) => '整理筆記失敗：' + err,
    memoryDirMissing: (dir) => '記憶資料夾不存在：' + dir,
    modelNoReply: (reason) => '模型沒有回應：' + reason,
    distilling: '整理筆記中…',
    neverDistilled: '還沒整理過',
    lastDistill: (at, why, d) => '上次整理 ' + at + '（' + why + '）：新增 ' + d.added.length + '、加次數 ' + d.confirmed.length + (d.rejected.length ? '、丟掉 ' + d.rejected.length : ''),
    lastDistillFail: (at, why, err) => '上次整理 ' + at + '（' + why + '）：失敗 ' + err,
    untilNext: (n) => ' · 再 ' + n + ' 則自動整理',
    distillNow: '立即整理',
    countTag: (n) => ' ×' + n,
    promotedTag: ' ✓專案',
    distillPrompt: (memories, talk) =>
      [
        '你在背景整理一段 Claude Code 對話，目標是讓使用者不用把同樣的要求講第二次。你沒有工具，只輸出指定格式，由程式寫檔。',
        '用使用者在對話裡使用的語言撰寫（使用者寫中文就用繁體中文（台灣））；程式碼、指令、路徑與專有名詞維持原文。',
        '',
        '只記使用者自己說出的這兩類：',
        '- feedback：使用者對做事方式的要求、偏好與糾正（例如「不要自己 commit」「表單用多選」）',
        '- user：使用者自己的背景（角色、熟悉的技術、工作習慣）',
        '不記：專案的事實與進度、只跟眼前這件工作有關的一次性指示、Claude 自己的推論與說明、使用者只回「好」「可以」的事。',
        '',
        '動作（每行一個 JSON）：',
        '- 使用者又講了一次現有記憶的內容，或又糾正了同一件事：{"op":"confirm","name":"<現有記憶的 name>","quote":"<使用者原話>"}',
        '- 新的、之後的對話也用得到的：{"op":"add","name":"<英數小寫與連字號>","title":"<簡短標題>","type":"feedback|user","layer":"user|project","description":"<一行摘要>","body":"<規則本身>\\n\\n**Why:** <理由>\\n**How to apply:** <什麼時候、怎麼做>","quote":"<使用者原話>"}',
        '- layer：user＝跨專案都適用的個人偏好；project＝只適用這個專案',
        '- quote 必須從【使用者】的訊息逐字複製一小段（程式會比對，對不上的會被丟掉）',
        '- 同一件事已經有現有記憶就用 confirm，不要 add 重複的；同一則記憶這次最多 confirm 一次',
        '',
        '輸出：在 ' + ACTIONS_START + ' 與 ' + ACTIONS_END + ' 之間，每行一個 JSON；沒有要做的就兩行標記之間留空。',
        '',
        '=== 現有記憶 ===',
        ...(memories.length
          ? memories.map((m) => '- ' + m.name + '｜' + m.type + (m.layer ? '／' + m.layer : '') + '｜講過 ' + m.count + ' 次｜' + clip(squash(m.description || m.body), 120))
          : ['（無）']),
        '',
        '=== 對話 ===',
        ...talk.map((t) => (t.role === 'user' ? '【使用者】' + clip(t.text, USER_MAX) : '【Claude】' + clip(squash(t.text), ASSISTANT_MAX))),
      ].join('\n'),
    promote: (items, dir) =>
      [
        '[baton] 下面這些要求使用者已經講了 ' + PROMOTE_COUNT + ' 次以上，寫在記憶裡還不夠。先做完使用者這次交代的事，再處理；使用者在處理緊急問題時先不要做。',
        '- layer 是 project 的：放進專案放規則的地方（CLAUDE.md、AGENTS.md 或現有的 hook），先檢查是否已經寫過、不要 commit，用一句話告訴使用者加了什麼、放在哪。',
        '- layer 是 user 的：先問使用者要不要加進全域的 ~/.claude/CLAUDE.md，使用者說好才加。',
        '- 放好後在那則記憶檔的 metadata 加上 `promoted: <放的檔案路徑>` 和 `promoted_count: <當時的 count>`；使用者說不要放就加 `promoted: declined`。',
        ...items.map((m) => '- ' + m.name + '（' + (m.layer || 'project') + '，講過 ' + m.count + ' 次）：' + m.description + '｜' + dir + '/' + m.file),
      ].join('\n'),
    // 守門
    cmdGuard: '守門：list｜suggest｜on N｜off N｜drop N｜mode N deny|remind',
    guardUsage: '用法：/guard [list|suggest|on N|off N|drop N|mode N deny|remind]',
    guardsReadFail: (err) => '讀取守門失敗：' + err,
    guardBusy: '正在起草守門',
    guardNoCandidates: '目前沒有需要起草守門的規則',
    guardNoneFit: (n) => '沒有適合寫成守門的規則' + (n ? '（丟掉 ' + n + ' 條）' : ''),
    guardDrafted: (n) => '起草了 ' + n + ' 條守門，下一段對話會請 Claude 問你要不要採用',
    guardDraftFail: (err) => '起草守門失敗：' + err,
    guardDenyToast: (id, tool, rule) => '守門 #' + id + ' 擋下 ' + tool + '（' + rule + '）',
    guardHead: (g) => '[baton] 守門 #' + g.id + '（規則「' + g.rule + '」）：' + g.message,
    guardDenyHint: (id) => '使用者核准過這條守門；確定要做就請使用者自己執行，或請使用者用 /guard off ' + id + ' 停用。',
    guardSummary: (on, proposed, off) => '守門：啟用 ' + on + '、待問 ' + proposed + '、停用 ' + off + '（/guard 查看）',
    guardNone: (n) => '還沒有守門。同一個要求放進專案後又被糾正，或你不讓它放進專案、卻講了 ' + n + ' 次，整理筆記後會起草；也可以打 /guard suggest。',
    guardList: (guards, hits) => {
      const state = { proposed: '待問', on: '啟用', off: '停用' }
      return guards
        .flatMap((g) => [
          '#' + g.id + ' ' + (state[g.state] ?? g.state) + '・' + (g.mode === 'deny' ? '擋下' : '提醒') + '・' + g.rule + (hits[g.id] ? '（命中 ' + hits[g.id] + ' 次）' : ''),
          '   ' + g.tool + ' 符合 /' + g.match + '/' + (g.unless ? '，除非 /' + g.unless + '/' : ''),
          '   → ' + g.message,
        ])
        .join('\n')
    },
    guardAsk: (drafts, file) =>
      [
        '[baton] 下面這些要求已經寫成文字，AI 還是一再違反，baton 起草了守門：在 AI 呼叫工具之前比對參數，違規時提醒或擋下。先做完使用者這次交代的事，再在回覆最後用一兩句白話問使用者要不要採用：說明它在什麼情況會出現、會做什麼。使用者正在處理緊急問題就不要問；沒回應就不要追問。',
        ...drafts.map(
          (g) =>
            '- 守門 #' + g.id + '（' + (g.mode === 'deny' ? '擋下' : '提醒') + '）：規則「' + g.rule + '」｜工具 ' + g.tool + ' 符合 /' + g.match + '/' + (g.unless ? '，除非 /' + g.unless + '/' : '') + ' 時，告訴 AI：' + g.message,
        ),
        '使用者說要：把 ' + file + ' 裡那一條的 "state" 改成 "on"（想改成只提醒或擋下就改 "mode"）；說不要：改成 "off"。',
      ].join('\n'),
    guardPrompt: (rules, tools) =>
      [
        '你替一個 Claude Code 工作區設計「守門」：在 AI 呼叫工具之前，用正規表達式比對工具參數，攔下違反規則的呼叫。',
        '下面是使用者反覆糾正、寫成文字還是一再被違反的規則。逐條判斷：違規時，工具參數裡有沒有明確、可比對的特徵？',
        '',
        '只在這些情況提出守門：',
        '- 違規一定經過某個工具，參數有明確特徵（指令、工具名稱、路徑）',
        '- 有 unless 可以排除照規則做的正確寫法',
        '不要提出：規則講的是回答裡的說法、判斷順序、寫作內容，或特徵太模糊會擋到正常工作的。',
        '',
        '比對方式：',
        '- tool：工具名稱原樣，例如 Bash、Edit、mcp__x__y；結尾 * 表示前綴',
        '- 比對文字：工具參數的字串值以換行串起來（Bash 就是 command 本身）；不分大小寫的 JavaScript 正規表達式',
        '- match／unless 各不超過 ' + PATTERN_MAX + ' 字；寧可窄、不要寬',
        '- 特殊字元要跳脫：. 寫 \\.；寫進 JSON 時每個反斜線再寫成 \\\\',
        '- bad：一段違規的比對文字範例（要被 match 命中、不被 unless 排除）；good：一段照規則做、也用同一個工具的正確範例（不能被擋）。程式會實際比對，不符就丟掉',
        '- mode：deny（執行前擋下）只用在不可逆或代價高的錯誤；其他用 remind（照常執行，之後提醒）',
        '- message：給 AI 看的一句話，說該改成怎麼做',
        '',
        '這個工作區最近用過的工具：' + (tools.length ? tools.join(', ') : '（無紀錄）'),
        '',
        '輸出：在 ' + GUARDS_START + ' 與 ' + GUARDS_END + ' 之間，每行一個 JSON，每條規則最多一個；沒有適合的就兩行標記之間留空。',
        '{"rule":"<規則 name，原樣>","tool":"Bash","match":"<regex>","unless":"<regex，可省略>","mode":"remind","message":"<一句話>","bad":"<違規範例>","good":"<正確範例>"}',
        '',
        '=== 規則 ===',
        ...rules.flatMap((r) => ['### ' + r.name + '（講過 ' + r.count + ' 次）', r.description, r.body]),
      ].join('\n'),
  },
  en: {
    handoffPrefix: '[auto-handoff]',
    paneTitle: 'Work board',
    launcher: '◧ Work board',
    cmdBoard: 'Toggle the work board (progress / memory / cache countdown)',
    cmdHandoff: 'Hand off now: write the handoff, then compact (same as "Hand off now" on the board)',
    registerFail: (name, err) => 'Failed to register /' + name + ': ' + err,
    laneStates: { blocked: 'Waiting on you', failed: 'Failed', review: 'Review', working: 'Working', idle: 'Idle', done: 'Done' },
    layers: {
      user: ['User', 'Your preferences and habits, always included'],
      project: ['Project', 'Long-lived facts and decisions'],
      workstream: ['Workstream', 'Tied to a lane'],
      phase: ['Phase', 'The current stretch; expires'],
      none: ['Unlayered', 'No layer set yet'],
    },
    types: { feedback: 'Feedback', user: 'About you', project: 'Project', reference: 'Reference', other: 'Other' },
    herdrActions: {
      prompt: 'assigned work',
      'send-keys': 'sent keys',
      read: 'read output',
      wait: 'waited',
      focus: 'focused',
      start: 'started agent',
      split: 'split new pane',
      run: 'ran command',
      'send-text': 'sent text',
      close: 'closed',
    },
    justNow: 'just now',
    minutesAgo: (n) => n + ' min ago',
    hoursAgo: (n) => n + ' h ago',
    dialogWaiting: 'Dialog awaiting confirmation',
    waitingOn: (needs) => 'Waiting on you: ' + needs,
    failed: (detail) => 'Failed' + (detail ? ': ' + detail : ''),
    failedAt: (step) => 'Failed at ' + step,
    reviewDone: 'Done, needs review',
    running: (d) => '● Running ' + d,
    stale: (ago) => 'last update ' + ago,
    idle: 'Idle',
    accepted: 'Accepted',
    noTasksDir: 'Tasks folder not found',
    unreadable: (names) => 'Unreadable: ' + names.join(', '),
    lanesReadFail: (err) => 'Failed to read lanes: ' + err,
    toastBlocked: (lane, needs) => lane + ' is waiting on you: ' + needs,
    toastReview: (lane) => lane + ' is done and needs review',
    toastFailed: (lane) => lane + ' failed',
    screenFail: (err) => 'Cannot read screen: ' + err,
    sendFail: (err) => 'Not sent: ' + err,
    sentTo: (lane) => 'Sent to ' + lane,
    keyFail: (err) => 'Key not sent: ' + err,
    reportMissing: 'Report file not found',
    reportFail: (err) => 'Cannot read report: ' + err,
    settingsReadFail: (err) => 'Failed to read project settings: ' + err,
    compactWriteFail: (err) => 'Failed to write compaction summary: ' + err,
    memoryReadFail: (err) => 'Failed to read memory: ' + err,
    herdrReadFail: (err) => 'Failed to read herdr: ' + err,
    herdrBlocked: (who) => who + ' is waiting for confirmation',
    herdrDone: (who) => who + ' finished',
    handoffToast: 'Cache expiring soon, writing handoff',
    handoffSent: 'Handoff instruction sent',
    handoffBlocked: (why) => 'Handoff instruction blocked: ' + why,
    handoffSubmitFail: (err) => 'Failed to send handoff instruction: ' + err,
    alreadyHandingOff: 'Handoff already in progress',
    alreadyCompacting: 'Compaction in progress',
    compactSkipped: (why) => 'Compaction skipped: ' + why,
    compactDone: 'Handed off and compacted',
    compactFail: (err) => 'Compaction failed: ' + err,
    contextTooSmall: (p) => 'Context only ' + p + '%, skipping auto-handoff',
    handoffAborted: 'Handoff turn was interrupted; not compacting',
    handoffWritten: 'Handoff written; compacting',
    runningTools: (d, n) => '● Running ' + d + ' · ' + n + ' tool calls this turn',
    idleState: '○ Idle',
    context: (p) => 'Context ' + p + '%',
    tasksHeader: (done, total) => 'Tasks ' + done + '/' + total,
    lastReply: 'Last reply',
    compactKept: (at) => 'Kept after compaction (' + at + ')',
    handoffDoc: (at) => 'Handoff (' + at + ')',
    onlySection: (s) => ' · section "' + s + '" only',
    noHandoff: 'No handoff document yet',
    dueReview: ' ⚠ due for review',
    dueReviewN: (n) => ' ⚠ ' + n + ' due for review',
    memoryCount: (n) => n + (n === 1 ? ' memory' : ' memories'),
    refresh: 'Refresh',
    noMemories: 'No memories in this folder yet.',
    back: '← Back',
    tasks: 'Tasks',
    noLanes: 'No lane status files yet.',
    needsYou: (n) => 'Needs you ' + n,
    working: (n) => 'Working ' + n,
    quiet: (idle, done) => 'Idle ' + idle + ' · Done ' + done,
    otherAgents: (n) => 'Other agents (no status file) ' + n,
    updated: (ago) => 'updated ' + ago,
    spec: 'Spec ',
    decide: 'Decision needed',
    notes: 'Notes',
    liveScreen: 'Live screen',
    loading: 'Loading…',
    less: 'Less',
    more: 'More',
    keys: 'Keys',
    dialogPlaceholder: 'A dialog is waiting; use the keys above first',
    replyPlaceholder: (lane) => 'Reply to ' + lane + '…',
    send: 'Send',
    report: 'Report',
    laneMemories: (n) => 'Memories for this lane (' + n + ')',
    laneGone: "This lane's status file is gone.",
    notAgent: 'exited or not an agent pane',
    thisPane: (id) => 'This pane ' + id,
    commanded: (n) => 'Commanded by this session (' + n + ')',
    noCommanded: 'No panes commanded through herdr yet.',
    lastAction: (action, detail, ago) => 'Last: ' + action + (detail ? ' "' + detail + '"' : '') + ' · ' + ago,
    sameWorkspace: (n) => 'Other agents in this workspace (' + n + ')',
    cache: 'Cache',
    cacheNotYet: 'not created',
    cacheExpired: (d) => 'expired ' + d + ' ago',
    handingOff: 'Handing off…',
    compacting: 'Compacting…',
    ttlNoAuto: (ttl) => 'Cache ' + ttl + ', no auto-handoff',
    standby: 'Standby',
    doneWaiting: 'Done, waiting for input',
    model: (m) => 'Model ' + m,
    autoHandoff: 'Auto-handoff',
    handoffNow: 'Hand off now',
    tabMemory: (n) => 'Memory (' + n + ')',
    tabHandoff: 'Handoff',
    tabProgress: 'Progress',
    wrap: 'Wrap',
    count: (label, n) => label + ' (' + n + ')',
    laneBriefing: (c) => [
      '[baton] This project hands off through lane status files:',
      '- Lane status: ' + c.tasksDir + '/<lane>.json, one per lane; yours is ' + c.selfLane + '.json. Format and update rules are in that folder\'s README.',
      '- Detailed handoff: ' + c.handoffFile + (c.handoffSection ? ', section "' + c.handoffSection + '"' : '') + '; read it when you need details.',
      '- Memory: ' + c.memoryDir + ' (frontmatter metadata.layer: user / project / workstream / phase)',
      "- When the lead session's prompt cache is about to expire, you'll be asked to update your own status file, then the conversation is compacted automatically.",
      '',
      "Lane overview (ignore if unrelated to the user's request):",
    ],
    laneLine: (lane, title, percent, done, total, standing) => lane + ': ' + title + ' ' + percent + '% (' + done + '/' + total + ') · ' + standing,
    laneSelfSteps: (lane) => 'Your steps (' + lane + '):',
    laneSelfNeeds: (needs) => 'Waiting on the user: ' + needs,
    briefing: (c) => [
      '[baton] This project uses the baton handoff mechanism:',
      '- Handoff document: ' +
        c.handoffFile +
        (c.handoffSection ? ', section "' + c.handoffSection + '" (a project document; update only that section)' : '') +
        (c.handoffAt ? ' (last updated ' + c.handoffAt + ')' : ' (not created yet)'),
      '- Compaction summary: ' + c.compactFile,
      '- Memory folder: ' + c.memoryDir,
      "- When the lead session's prompt cache is about to expire, you'll be asked to update the handoff document, then the conversation is compacted automatically.",
      "- This project has no Tasks tab yet. If the work has several parallel lines (work dispatched through herdr, a backlog to dispatch, several items in progress in the handoff), ask the user at a suitable moment whether to create one; don't create it yourself.",
      '  How: write {"tasks_dir": "<folder>"} to ' +
        c.projectSettingsFile +
        '; in that folder, one <lane>.json per lane: lane, title (one line), state (blocked / failed / review / working / idle / done), steps ({ id, title, state: todo|doing|done|skip }), updated; optional needs, pane, spec, head, report, notes. The lead\'s own file is ' +
        c.selfLane +
        '.json.',
    ],
    briefingHandoff: "Below is the current handoff document; continue the earlier work from it. Ignore it if unrelated to the user's request.",
    handoffHead: (min) => 'The prompt cache expires in about ' + min + ' min, and the conversation will be compacted right after. Now:',
    handoffLane: (c) => [
      '1. Overwrite your own status file `' + c.tasksDir + '/' + c.selfLane + '.json`: update step states truthfully; put decisions for the user in needs; put anything the next session must know that is not a step in notes (at most 8, one line each). Validate it per that folder\'s README and update any overview it says to generate.',
      '2. Also update the status files of lanes you accepted or whose state change you confirmed.',
      '3. If there are user instructions or project facts worth keeping long-term, update memory (`' + c.memoryDir + '`, with metadata.layer).',
      "4. Don't start new work. Reply with one or two sentences when done.",
    ],
    handoffDocSteps: (c) => [
      (c.handoffSection
        ? '1. Update the current "' + c.handoffSection + '" section of `' + c.handoffFile + '` (a project document: follow its existing format and conventions; don\'t rewrite the whole file or touch other sections): '
        : '1. Write the current progress to `' + c.handoffFile + '` (overwrite the whole file, keep it concise): ') +
        'goal, done, in progress, next steps, key files and decisions, open questions for the user.',
      '2. If there are user instructions or project facts worth keeping long-term, update memory (`' + c.memoryDir + '`).',
      "3. Don't start new work. Reply with one or two sentences when done.",
    ],
    compactLane: (dir) => 'Keep the progress, decisions waiting on the user and next steps referenced by the lane status files in ' + dir + '; after compaction, continue from the status files.',
    compactDoc: (file, section) => 'Keep the key points of ' + file + (section ? ', section "' + section + '"' : '') + ', the current task state and next steps; after compaction, continue from the handoff document.',
    // Nudges (for Claude; the user doesn't see them)
    retryNudge: (tool, brief) =>
      '[baton] This tool (' + tool + ') failed twice in a row for the same reason (' + (brief || 'no error text') + "). If the error looks transient (timeout, still loading, dropped connection), wait a moment and try once more; otherwise find the cause and change approach instead of retrying as is.",
    doneCheck: {
      unverified: "[baton] You said it's done, but no test or check ran after you edited files this turn. Run the tests or checks relevant to this change and include what you ran and the result in your reply; if something can't be verified, say what wasn't verified and why instead of saying it's done.",
      failed: "[baton] You said it's done, but the tests or checks after your edits this turn did not pass. Fix the problem and run them again, including the result in your reply; if it can't be fixed or is unrelated to this change, explain the failure honestly instead of saying it's done.",
    },
    // Notes
    cmdDistill: 'Update notes now: write your requests and corrections since the last pass into the memory folder',
    distillWhy: { manual: 'manual', handoff: 'before handoff', every: (n) => 'every ' + n + ' messages' },
    distillOff: 'Notes are off (distill in /config)',
    distillBusy: 'Already updating notes',
    distillStarted: (n) => 'Updating notes (' + n + ' new messages)',
    distillNothing: 'No new conversation since the last pass',
    distillRunning: (why) => 'Updating notes (' + why + ')',
    distillDone: (added, confirmed) => 'Notes updated: ' + added + ' added, ' + confirmed + ' counted again',
    distillFail: (err) => 'Updating notes failed: ' + err,
    memoryDirMissing: (dir) => 'Memory folder not found: ' + dir,
    modelNoReply: (reason) => 'No reply from the model: ' + reason,
    distilling: 'Updating notes…',
    neverDistilled: 'Not updated yet',
    lastDistill: (at, why, d) => 'Last pass ' + at + ' (' + why + '): ' + d.added.length + ' added, ' + d.confirmed.length + ' counted again' + (d.rejected.length ? ', ' + d.rejected.length + ' dropped' : ''),
    lastDistillFail: (at, why, err) => 'Last pass ' + at + ' (' + why + '): failed ' + err,
    untilNext: (n) => ' · next in ' + n + ' messages',
    distillNow: 'Update now',
    countTag: (n) => ' ×' + n,
    promotedTag: ' ✓project',
    distillPrompt: (memories, talk) =>
      [
        "You are tidying up a Claude Code conversation in the background so the user never has to repeat the same request. You have no tools; output only the format below and a program writes the files.",
        "Write in the language the user uses in the conversation; keep code, commands, paths and proper nouns as they are.",
        '',
        'Record only these two kinds, as said by the user themselves:',
        "- feedback: the user's requests, preferences and corrections about how to work (e.g. \"don't commit on your own\", \"use multi-select in forms\")",
        "- user: the user's own background (role, familiar tech, work habits)",
        'Do not record: project facts and progress, one-off instructions for the task at hand, Claude\'s own reasoning and explanations, things the user only answered "ok" to.',
        '',
        'Actions (one JSON per line):',
        '- The user said the same thing as an existing memory again, or corrected the same thing again: {"op":"confirm","name":"<existing memory name>","quote":"<the user\'s exact words>"}',
        '- Something new that later conversations will also need: {"op":"add","name":"<lowercase letters, digits and hyphens>","title":"<short title>","type":"feedback|user","layer":"user|project","description":"<one-line summary>","body":"<the rule itself>\\n\\n**Why:** <reason>\\n**How to apply:** <when and how>","quote":"<the user\'s exact words>"}',
        '- layer: user = a personal preference that applies across projects; project = applies only to this project',
        '- quote must be copied verbatim from a [User] message (the program checks; anything that does not match is dropped)',
        '- If an existing memory already covers it, use confirm instead of adding a duplicate; confirm each memory at most once per pass',
        '',
        'Output: one JSON per line between ' + ACTIONS_START + ' and ' + ACTIONS_END + '; leave nothing between the two markers if there is nothing to do.',
        '',
        '=== Existing memories ===',
        ...(memories.length
          ? memories.map((m) => '- ' + m.name + ' | ' + m.type + (m.layer ? '/' + m.layer : '') + ' | said ' + m.count + ' times | ' + clip(squash(m.description || m.body), 120))
          : ['(none)']),
        '',
        '=== Conversation ===',
        ...talk.map((t) => (t.role === 'user' ? '[User] ' + clip(t.text, USER_MAX) : '[Claude] ' + clip(squash(t.text), ASSISTANT_MAX))),
      ].join('\n'),
    promote: (items, dir) =>
      [
        "[baton] The user has said each of these " + PROMOTE_COUNT + "+ times; keeping them in memory isn't enough. Finish what the user asked for this time first, then handle them; skip this while the user is dealing with something urgent.",
        "- layer project: put it where the project keeps its rules (CLAUDE.md, AGENTS.md or an existing hook); check it isn't already there, don't commit, and tell the user in one sentence what you added and where.",
        '- layer user: ask the user first whether to add it to the global ~/.claude/CLAUDE.md, and add it only if they agree.',
        "- Once placed, add `promoted: <file path>` and `promoted_count: <count at that time>` to that memory file's metadata; if the user doesn't want it placed, add `promoted: declined`.",
        ...items.map((m) => '- ' + m.name + ' (' + (m.layer || 'project') + ', said ' + m.count + ' times): ' + m.description + ' | ' + dir + '/' + m.file),
      ].join('\n'),
    // Guards
    cmdGuard: 'Guards: list | suggest | on N | off N | drop N | mode N deny|remind',
    guardUsage: 'Usage: /guard [list|suggest|on N|off N|drop N|mode N deny|remind]',
    guardsReadFail: (err) => 'Could not read guards: ' + err,
    guardBusy: 'Already drafting guards',
    guardNoCandidates: 'No rules need a guard right now',
    guardNoneFit: (n) => 'No rule fits a guard' + (n ? ' (' + n + ' dropped)' : ''),
    guardDrafted: (n) => 'Drafted ' + n + ' guard(s); the next conversation will ask you whether to adopt them',
    guardDraftFail: (err) => 'Drafting guards failed: ' + err,
    guardDenyToast: (id, tool, rule) => 'Guard #' + id + ' blocked ' + tool + ' (' + rule + ')',
    guardHead: (g) => '[baton] Guard #' + g.id + ' (rule "' + g.rule + '"): ' + g.message,
    guardDenyHint: (id) => 'The user approved this guard; if it really needs doing, ask the user to run it themselves, or to disable the guard with /guard off ' + id + '.',
    guardSummary: (on, proposed, off) => 'Guards: ' + on + ' on, ' + proposed + ' to ask, ' + off + ' off (/guard to see)',
    guardNone: (n) => "No guards yet. They're drafted after a notes pass when a request placed in the project is corrected again, or one you kept out of the project has been said " + n + ' times; or run /guard suggest.',
    guardList: (guards, hits) => {
      const state = { proposed: 'to ask', on: 'on', off: 'off' }
      return guards
        .flatMap((g) => [
          '#' + g.id + ' ' + (state[g.state] ?? g.state) + ' · ' + (g.mode === 'deny' ? 'block' : 'remind') + ' · ' + g.rule + (hits[g.id] ? ' (hit ' + hits[g.id] + ' times)' : ''),
          '   ' + g.tool + ' matching /' + g.match + '/' + (g.unless ? ', unless /' + g.unless + '/' : ''),
          '   → ' + g.message,
        ])
        .join('\n')
    },
    guardAsk: (drafts, file) =>
      [
        '[baton] These requests are already written down, yet the AI keeps breaking them, so baton drafted guards: before the AI calls a tool, its arguments are matched and a violation gets a reminder or is blocked. Finish what the user asked for this time first, then at the end of your reply ask in a sentence or two whether to adopt them: say when each would fire and what it would do. Skip this while the user is dealing with something urgent; if they don\'t answer, don\'t ask again.',
        ...drafts.map(
          (g) =>
            '- Guard #' + g.id + ' (' + (g.mode === 'deny' ? 'block' : 'remind') + '): rule "' + g.rule + '" | when tool ' + g.tool + ' matches /' + g.match + '/' + (g.unless ? ', unless /' + g.unless + '/' : '') + ', tell the AI: ' + g.message,
        ),
        'If the user says yes: set that entry\'s "state" to "on" in ' + file + ' (change "mode" to switch between remind and block); if no: set it to "off".',
      ].join('\n'),
    guardPrompt: (rules, tools) =>
      [
        'You design "guards" for a Claude Code workspace: before the AI calls a tool, a regular expression is matched against the tool arguments to catch calls that break a rule.',
        'Below are rules the user corrected repeatedly that keep being broken even though they are written down. For each, decide: when it is broken, do the tool arguments have a clear, matchable feature?',
        '',
        'Propose a guard only when:',
        '- breaking the rule always goes through some tool, with a clear feature in the arguments (command, tool name, path)',
        '- an unless pattern can exclude the correct way of doing it',
        'Do not propose: rules about what the answer says, the order of judgment, writing content, or features so vague they would block normal work.',
        '',
        'Matching:',
        '- tool: the tool name as is, e.g. Bash, Edit, mcp__x__y; a trailing * means prefix',
        '- matched text: the string values of the tool arguments joined by newlines (for Bash, the command itself); case-insensitive JavaScript regular expressions',
        '- match / unless at most ' + PATTERN_MAX + ' characters each; prefer narrow to broad',
        '- escape special characters: write . as \\.; inside JSON write each backslash as \\\\',
        '- bad: an example of matched text that breaks the rule (must be hit by match and not excluded by unless); good: a correct example that follows the rule with the same tool (must not be caught). The program checks both and drops guards that fail',
        '- mode: deny (block before running) only for irreversible or costly mistakes; otherwise remind (run as usual, then remind)',
        '- message: one sentence for the AI saying what to do instead',
        '',
        'Tools used recently in this workspace: ' + (tools.length ? tools.join(', ') : '(none recorded)'),
        '',
        'Output: one JSON per line between ' + GUARDS_START + ' and ' + GUARDS_END + ', at most one per rule; leave nothing between the markers if none fit.',
        '{"rule":"<rule name, as is>","tool":"Bash","match":"<regex>","unless":"<regex, optional>","mode":"remind","message":"<one sentence>","bad":"<violating example>","good":"<correct example>"}',
        '',
        '=== Rules ===',
        ...rules.flatMap((r) => ['### ' + r.name + ' (said ' + r.count + ' times)', r.description, r.body]),
      ].join('\n'),
  },
}
// 任何語言的交接前綴都認（切換語言前送出的交接指示也要能辨識）
const HANDOFF_PREFIXES = Object.values(I18N).map((x) => x.handoffPrefix)

// 語言：/config 的 language（auto／zh-TW／en），auto 在 session.start 決定
let languageSetting = 'auto'
let T = I18N['zh-TW']

// 介面狀態
let tab = 'progress'
let expanded = ''
let paneOpen = false
// 長文字（路徑、工具、任務、描述）要換行還是截成一行
let wrapLong = false
// 輸入框上方的「工作看板」按鈕（/config 的 launcher_button）
let launcherButton = true

// 執行狀態
let working = false
let turnStartedAt = 0
let currentTool = ''
let toolCalls = 0
let lastAnswer = ''
let usage = null
let model = ''

// Herdr：這個 session 透過 herdr 指令指揮過的目標，以及 herdr agent list 的即時狀態
let herdrEnv = false
// herdr 執行檔：herdr 會設 HERDR_BIN_PATH（macOS 上通常是 ~/.local/bin/herdr），不靠 PATH 找
let herdrBin = 'herdr'
let herdrSelf = ''
let herdrWorkspace = ''
let herdrTargets = {} // target → { target, action, detail, at }
let herdrAgents = []
let herdrStatus = {} // pane_id → 上次看到的狀態，用來偵測變化
let herdrError = ''
let herdrCommandAt = 0

// 任務：TodoWrite 的清單，或 Task 工具建立的任務
let todos = []
let tasks = {}

// lane 狀態檔
let tasksDir = ''
let selfLane = 'architect'
let lanes = []
let lanesError = ''
let laneStates = {} // lane → 上次看到的 state，用來在變成等你／待審／失敗時提醒
// 任務分頁的子頁堆疊：[{ view: 'lane' | 'report', lane, back }]；空的是列表。back 是返回後要捲回的元素 key
let route = []
let quietOpen = false
let screens = {} // lane → { lines, at, error }
let screenLong = false
let reports = {} // lane → { text, path, error }
// 記憶分層：哪些層展開
let layersOpen = { user: true, project: true, workstream: false, phase: false, none: true }

// 記憶與交接文件：設定值（原樣）與展開後的絕對路徑
let memorySetting = DEFAULT_MEMORY_DIR
let handoffSetting = DEFAULT_HANDOFF_PATH
// 專案覆寫檔（PROJECT_SETTINGS）的內容
let projectSettings = {}
let projectSettingsFile = ''
// 兩個覆寫檔的位置（新、舊），任一個被改都重讀
let projectSettingsWatch = []
let memoryDir = ''
let handoffFile = ''
// 交接文件是專案自己的文件時，只讀、只更新這一節（例如「## 交接」），不整份覆寫
let handoffSection = ''
// 壓縮摘要存在交接文件旁邊：docs/HANDOFF.md → docs/HANDOFF.compact.md
let compactFile = ''
let compactInfo = { summary: '', at: 0, tokensBefore: 0, tokensAfter: 0 }
let compactOpen = false
// 新 session 或壓縮後的第一個 prompt，附上交接機制說明與交接文件
let briefOnStart = true
let needsBriefing = true
let memories = []
let handoff = { text: '', mtimeMs: 0 }

// 快取與自動交接
let sessionId = ''
let lastRequestAt = 0
let lastUserAt = 0
let cacheTtl = '1h'
// 最後一次由使用者送出 prompt 在這段時間內，才視為「還在進行中的工作」（/config 的 away_hours）
let activeWindowMs = 24 * HOUR
let auto = true
// 這個 session 輸入過 /board 才為 true；存在 store，mod 重新載入後仍保留
let activated = false
let armed = true
let phase = 'idle' // idle | handoff | compacting
let handoffTurnId = ''
let handoffSentAt = 0
let compactTries = 0
let note = ''

// 防呆提醒（熱重載會清掉；清掉只是少一次提醒）
let retryNudge = true
let doneCheckOn = true
let replyLanguage = 'auto' // auto＝跟著 Claude Code 的 language 設定；off；或 zh-TW／zh-CN／en／ja
let replyTarget // 目標語言；undefined＝不提醒
let streaks = new Map()
let work = freshWork()
let reply = freshReply()

// 自動整理筆記
let distillOn = true
let distillEvery = 30
let notesModel = 'sonnet'
let talk = { items: [], humans: 0 } // 上次整理之後的對話：使用者親手打的訊息與 Claude 的回答
let distilling = false
let lastDistill = null // { at, why, added: [], confirmed: [], rejected: [], error }

// 守門
let guardsFile = ''
let guards = []
let guardHitCounts = {} // id → 命中次數
let drafting = false
let toolsSeen = new Set() // 這個 session 用過的工具名稱，起草守門時給模型參考

function pad(n) {
  return String(n).padStart(2, '0')
}

function duration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return h > 0 ? h + ':' + pad(m) + ':' + pad(s % 60) : pad(m) + ':' + pad(s % 60)
}

function clock(ms) {
  const d = new Date(ms)
  return pad(d.getMonth() + 1) + '/' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
}

function clip(text, max) {
  const one = String(text ?? '').replace(/\s+/g, ' ').trim()
  return one.length > max ? one.slice(0, max - 1) + '…' : one
}

function bar(ratio, width) {
  const filled = Math.round(Math.max(0, Math.min(1, ratio)) * width)
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

function toolLabel(e) {
  const arg = e.command ?? e.file_path ?? e.pattern ?? e.url ?? e.description ?? ''
  return arg ? e.tool + '(' + clip(arg, 40) + ')' : e.tool
}

function parseMemory(file, raw) {
  // Windows 存的檔案可能是 CRLF 換行
  const text = raw.replace(/\r\n/g, '\n')
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  const front = m ? m[1] : ''
  const field = (key) => (front.match(new RegExp('^\\s*' + key + ':\\s*(.+)$', 'm')) ?? [])[1]?.trim() ?? ''
  const unquote = (value) => value.replace(/^(["'])(.*)\1$/, '$2')
  return {
    file,
    name: field('name') || file.replace(/\.md$/, ''),
    description: unquote(field('description')),
    type: field('type') || 'other',
    layer: field('layer'),
    lane: field('lane'),
    reviewBy: field('review_by'),
    // 整理筆記記下的：使用者講過幾次、最後一次是哪天、放進專案了沒（路徑或 declined）與當時的次數
    count: Number(field('count')) || 1,
    lastSeen: field('last_seen'),
    promoted: unquote(field('promoted')),
    promotedCount: Number(field('promoted_count')) || 0,
    body: (m ? m[2] : text).trim(),
  }
}

// 終端的顯示寬度：全形字算兩格
function cellWidth(ch) {
  return /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? 2 : 1
}

function clipCells(text, max) {
  const one = String(text ?? '').replace(/\s+/g, ' ').trim()
  let width = 0
  let out = ''
  for (const ch of one) {
    width += cellWidth(ch)
    if (width > max - 1) return out + '…'
    out += ch
  }
  return out
}

// 不分大小寫：Windows（NTFS）與 macOS（APFS 預設）的檔名都不分大小寫
function samePath(a, b) {
  const norm = (p) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  return norm(a) === norm(b)
}

// 把設定值展開成絕對路徑；Windows 的反斜線一律轉成 /
async function expandPath($, raw) {
  const rootRaw = await $.session.root()
  const root = rootRaw.replace(/\\/g, '/')
  // 家目錄：Windows 是 USERPROFILE（C:\Users\<名稱>），macOS／Linux 沒有它，用 HOME（/Users/<名稱>）
  const home = ((await $.env.get('USERPROFILE')) || (await $.env.get('HOME')) || '').replace(/\\/g, '/')
  const config = ((await $.env.get('CLAUDE_CONFIG_DIR')) || home + '/.claude').replace(/\\/g, '/')
  let p = String(raw).trim().replace(/\\/g, '/')
  p = p
    .replaceAll('{config}', config)
    // 和 Claude Code 的專案資料夾同名：macOS /Users/u/app → -Users-u-app，Windows D:\work\app → D--work-app
    .replaceAll('{project}', rootRaw.replace(/[^A-Za-z0-9]/g, '-'))
    .replaceAll('{root}', root)
  if (p === '~' || p.startsWith('~/')) p = home + p.slice(1)
  // 絕對路徑：macOS 從 / 開始，Windows 從磁碟代號（D:/）開始
  if (!/^([A-Za-z]:)?\//.test(p)) p = root + '/' + p
  return p.replace(/\/+$/, '')
}

async function loadProjectSettings($) {
  projectSettings = {}
  const primary = await expandPath($, PROJECT_SETTINGS)
  const legacy = await expandPath($, LEGACY_PROJECT_SETTINGS)
  projectSettingsWatch = [primary, legacy]
  projectSettingsFile = primary
  try {
    if (!(await $.fs.exists(primary)) && (await $.fs.exists(legacy))) projectSettingsFile = legacy
    if (!(await $.fs.exists(projectSettingsFile))) return
    const parsed = JSON.parse(await $.fs.read(projectSettingsFile))
    if (parsed && typeof parsed === 'object') projectSettings = parsed
  } catch (err) {
    note = T.settingsReadFail(String(err))
  }
}

async function resolvePaths($) {
  await loadProjectSettings($)
  const pick = (key, fallback) => (typeof projectSettings[key] === 'string' && projectSettings[key].trim() ? projectSettings[key] : fallback)
  memoryDir = await expandPath($, pick('memory_dir', memorySetting))
  handoffFile = await expandPath($, pick('handoff_path', handoffSetting))
  handoffSection = pick('handoff_section', '').trim()
  // 壓縮摘要預設放在全域交接文件旁邊，不會因專案改用自己的交接文件而寫進 repo
  const defaultCompact = (await expandPath($, handoffSetting)).replace(/\.md$/i, '') + '.compact.md'
  compactFile = projectSettings.compact_path ? await expandPath($, projectSettings.compact_path) : defaultCompact
  tasksDir = pick('tasks_dir', '') ? await expandPath($, projectSettings.tasks_dir) : ''
  selfLane = pick('tasks_self', 'architect').trim()
  guardsFile = await expandPath($, GUARDS_FILE)
}

function laneProgress(l) {
  const counted = l.steps.filter((s) => s.state !== 'skip')
  const done = counted.filter((s) => s.state === 'done').length
  return { done, total: counted.length, percent: counted.length ? Math.round((done * 100) / counted.length) : 0 }
}

function laneStep(l) {
  return l.steps.find((s) => s.state === 'doing') ?? l.steps.find((s) => s.state === 'todo')
}

function laneAgent(l) {
  return l.pane ? herdrAgents.find((a) => a.pane_id === l.pane || (a.name && a.name === l.pane)) : undefined
}

// Herdr 看到對話框在等確認（例如權限詢問），狀態檔不一定來得及寫
function laneDialog(l) {
  return laneAgent(l)?.agent_status === 'blocked'
}

function needsAttention(l) {
  return l.state === 'blocked' || l.state === 'failed' || l.state === 'review' || laneDialog(l)
}

// 第二行：在等誰、做到哪
function laneStanding(l, now) {
  const step = laneStep(l)
  if (laneDialog(l) && l.state !== 'blocked') return T.dialogWaiting
  if (l.state === 'blocked') return T.waitingOn(l.needs ?? '')
  if (l.state === 'failed') return l.needs ? T.failed(l.needs) : step ? T.failedAt(step.id + ' ' + step.title) : T.failed('')
  if (l.state === 'review') return T.reviewDone + (l.head ? ' · HEAD ' + l.head : '')
  if (l.state === 'working') {
    if (l.lane === selfLane && working) return T.running(duration(now - turnStartedAt)) + (step ? ' · ' + step.id + ' ' + step.title : '')
    const stale = now - Date.parse(l.updated) > STALE_MS ? ' · ' + T.stale(ago(now - Date.parse(l.updated))) : ''
    return (step ? step.id + ' ' + step.title : '') + stale
  }
  if (l.state === 'idle') return l.needs || T.idle
  return T.accepted
}

async function loadLanes($) {
  if (!tasksDir) {
    lanes = []
    return
  }
  try {
    if (!(await $.fs.exists(tasksDir))) {
      lanes = []
      lanesError = T.noTasksDir
      return
    }
    const entries = await $.fs.list(tasksDir)
    const list = []
    const bad = []
    for (const f of entries.filter((x) => x.kind === 'file' && x.name.endsWith('.json'))) {
      try {
        const v = JSON.parse(await $.fs.read(tasksDir + '/' + f.name))
        if (!v || typeof v.lane !== 'string' || typeof v.title !== 'string' || !LANE_ORDER.includes(v.state) || !Array.isArray(v.steps)) throw new Error('invalid lane file')
        list.push(v)
      } catch {
        bad.push(f.name)
      }
    }
    lanes = list.sort((a, b) => LANE_ORDER.indexOf(a.state) - LANE_ORDER.indexOf(b.state) || a.lane.localeCompare(b.lane))
    lanesError = bad.length ? T.unreadable(bad) : ''
  } catch (err) {
    lanesError = T.lanesReadFail(String(err))
  }
  // 別的 lane 變成等你、待審、失敗時提醒（第一次載入不提醒）
  for (const l of lanes) {
    const prev = laneStates[l.lane]
    laneStates[l.lane] = l.state
    if (!prev || prev === l.state || l.lane === selfLane) continue
    if (l.state === 'blocked') $.ui.toast(clip(T.toastBlocked(l.lane, l.needs ?? ''), 80))
    if (l.state === 'review') $.ui.toast(T.toastReview(l.lane))
    if (l.state === 'failed') $.ui.toast(T.toastFailed(l.lane))
  }
  $.ui.invalidate('ui.render')
}

async function refreshScreen($, lane) {
  const l = lanes.find((x) => x.lane === lane)
  if (!l?.pane) return
  const at = await $.clock.now()
  try {
    const r = await $.process.run([herdrBin, 'pane', 'read', l.pane, '--lines', String(SCREEN_ROWS_LONG + 15), '--source', 'recent'], { timeoutMs: 5000 })
    if (r.exitCode !== 0) throw new Error(r.stderr || 'exit ' + r.exitCode)
    const lines = r.stdout
      .replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '')
      .replace(/\r/g, '')
      .replace(/\t/g, '  ')
      .replace(/[\x00-\x09\x0b-\x1f\x7f]/g, '')
      .split('\n')
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop()
    screens = { ...screens, [lane]: { lines, at, error: '' } }
  } catch (err) {
    screens = { ...screens, [lane]: { lines: [], at, error: T.screenFail(clip(String(err), 80)) } }
  }
  $.ui.invalidate('ui.render')
}

async function sendToLane($, lane, text) {
  const l = lanes.find((x) => x.lane === lane)
  if (!l?.pane || !String(text).trim()) return
  const r = await $.process.run([herdrBin, 'agent', 'prompt', l.pane, text], { timeoutMs: 10000 })
  if (r.exitCode !== 0) {
    $.ui.toast(T.sendFail(clip(r.stderr || r.stdout || 'exit ' + r.exitCode, 60)))
    return
  }
  $.ui.toast(T.sentTo(lane))
  herdrCommandAt = await $.clock.now()
  $.clock.after(1500, () => refreshScreen($, lane))
}

async function keyToLane($, lane, key) {
  const l = lanes.find((x) => x.lane === lane)
  if (!l?.pane) return
  const r = await $.process.run([herdrBin, 'agent', 'send-keys', l.pane, key], { timeoutMs: 5000 })
  if (r.exitCode !== 0) $.ui.toast(T.keyFail(clip(r.stderr || 'exit ' + r.exitCode, 60)))
  herdrCommandAt = await $.clock.now()
  $.clock.after(800, () => refreshScreen($, lane))
}

async function loadReport($, lane) {
  const l = lanes.find((x) => x.lane === lane)
  if (!l?.report) return
  try {
    const path = await expandPath($, l.report)
    if (!(await $.fs.exists(path))) {
      reports = { ...reports, [lane]: { text: '', path, error: T.reportMissing } }
    } else {
      reports = { ...reports, [lane]: { text: await $.fs.read(path), path, error: '' } }
    }
  } catch (err) {
    reports = { ...reports, [lane]: { text: '', path: l.report, error: T.reportFail(String(err)) } }
  }
  $.ui.invalidate('ui.render')
}

// 子頁：往下開一層，記住返回時要捲回哪個元素
async function openPage($, page) {
  route = [...route, page]
  $.ui.invalidate('ui.render')
  if (page.view === 'lane') await refreshScreen($, page.lane)
  if (page.view === 'report') await loadReport($, page.lane)
  try {
    await $.ui.scroll({ to: 'start', in: PANE })
  } catch {
    // 捲不動就算了
  }
}

async function goBack($) {
  const page = route[route.length - 1]
  route = route.slice(0, -1)
  $.ui.invalidate('ui.render')
  if (!page?.back) return
  try {
    await $.ui.scroll({ to: { key: page.back }, in: PANE, block: 'center' })
  } catch {
    // 列表還沒畫好時，稍後再捲一次
    $.clock.after(50, () => $.ui.scroll({ to: { key: page.back }, in: PANE, block: 'center' }).catch(() => {}))
  }
}

// 取出第一個符合 heading 的標題那一節（到下一個同級或更高級的標題為止，略過程式碼區塊）
// heading 是 "/.../" 時當正規表示式比對整行標題，否則比對開頭
function extractSection(text, heading) {
  const re = /^\/(.+)\/$/.exec(heading)
  const matches = re ? (line) => new RegExp(re[1]).test(line) : (line) => line.trim().startsWith(heading)
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  let start = -1
  let level = 0
  let fenced = false
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) fenced = !fenced
    if (fenced) continue
    const m = lines[i].match(/^(#{1,6})\s/)
    if (!m) continue
    if (start < 0) {
      if (matches(lines[i])) {
        start = i
        level = m[1].length
      }
    } else if (m[1].length <= level) {
      return lines.slice(start, i).join('\n').trim()
    }
  }
  return start < 0 ? '' : lines.slice(start).join('\n').trim()
}

async function loadCompact($) {
  try {
    if (!compactFile) await resolvePaths($)
    if (!(await $.fs.exists(compactFile))) return
    const st = await $.fs.stat(compactFile)
    const text = await $.fs.read(compactFile)
    // 檔案第一行是標頭，其餘是摘要
    // 改名前寫的標頭是 session-board
    const m = text.match(/^<!--\s*(?:baton|session-board):\s*(\{.*\})\s*-->\n?([\s\S]*)$/)
    const meta = m ? JSON.parse(m[1]) : {}
    compactInfo = {
      summary: (m ? m[2] : text).trim(),
      at: Number(meta.at) || st.mtimeMs,
      tokensBefore: Number(meta.tokensBefore) || 0,
      tokensAfter: Number(meta.tokensAfter) || 0,
    }
  } catch {
    // 讀不到就維持原狀
  }
}

async function saveCompact($) {
  try {
    if (!compactFile) await resolvePaths($)
    const meta = { at: compactInfo.at, tokensBefore: compactInfo.tokensBefore, tokensAfter: compactInfo.tokensAfter }
    await $.fs.write(compactFile, '<!-- baton: ' + JSON.stringify(meta) + ' -->\n' + compactInfo.summary + '\n')
  } catch (err) {
    note = T.compactWriteFail(String(err))
  }
  $.ui.invalidate('ui.render')
}

function ago(ms) {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return T.justNow
  if (s < 3600) return T.minutesAgo(Math.floor(s / 60))
  return T.hoursAgo(Math.floor(s / 3600))
}

const HERDR_AGENT_TARGETED = ['prompt', 'send-keys', 'read', 'wait', 'focus', 'get', 'rename', 'attach', 'explain']

// 從一段 shell 指令找出 herdr agent／pane 指令的目標（Windows 上可能寫成 herdr.exe）
function parseHerdr(command) {
  const found = []
  for (const segment of String(command).split(/&&|\|\||;|\n/)) {
    const m = segment.match(/\bherdr(?:\.exe)?\s+(agent|pane)\s+([\w-]+)(.*)$/)
    if (!m) continue
    const [, group, sub, rest] = m
    const tokens = [...rest.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((t) => t[1] ?? t[2] ?? t[3])
    const flag = (name) => {
      const i = tokens.indexOf(name)
      return i >= 0 ? tokens[i + 1] : undefined
    }
    const positional = []
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i] === '--') break
      if (tokens[i].startsWith('--')) {
        if (!/^--(wait|current|focus|no-focus|toggle|on|off|raw|ansi|json|verbose|takeover|clear|new-tab|new-workspace)$/.test(tokens[i])) i++
        continue
      }
      positional.push(tokens[i])
    }
    let target
    let detail = ''
    if (group === 'agent') {
      if (sub === 'start') {
        target = positional[0]
        detail = (flag('--kind') ?? '') + (flag('--pane') ? ' @ ' + flag('--pane') : '')
      } else if (HERDR_AGENT_TARGETED.includes(sub)) {
        target = positional[0]
        if (sub === 'prompt') detail = positional[1] ?? ''
        if (sub === 'send-keys') detail = positional.slice(1).join(' ')
      }
    } else {
      target = positional.find((t) => /^\w+:p\w+$/.test(t)) ?? flag('--pane') ?? flag('--target-pane')
      if (sub === 'run' || sub === 'send-text') detail = positional[1] ?? ''
    }
    // 跳過變數（例如 $HERDR_PANE_ID，通常是自己）和沒有目標的唯讀查詢
    if (!target || target.startsWith('$')) continue
    found.push({ target, action: sub, detail })
  }
  return found
}

async function refreshHerdr($) {
  if (!herdrEnv) return
  try {
    const r = await $.process.run([herdrBin, 'agent', 'list'], { timeoutMs: 5000 })
    if (r.exitCode !== 0) throw new Error(r.stderr || 'exit ' + r.exitCode)
    herdrAgents = JSON.parse(r.stdout)?.result?.agents ?? []
    herdrError = ''
  } catch (err) {
    herdrError = T.herdrReadFail(String(err))
    return
  }
  // 指揮過的 agent 進入 blocked／done 時提醒
  for (const a of herdrAgents) {
    const prev = herdrStatus[a.pane_id]
    herdrStatus[a.pane_id] = a.agent_status
    if (!prev || prev === a.agent_status || !isCommanded(a)) continue
    const who = a.name || a.agent + ' ' + a.pane_id
    if (a.agent_status === 'blocked') $.ui.toast(T.herdrBlocked(who))
    if (a.agent_status === 'done') $.ui.toast(T.herdrDone(who))
  }
  $.ui.invalidate('ui.render')
}

// 何時需要查 herdr：看板開在 Herdr 分頁、剛下過指令，或指揮過的 agent 還在 working／blocked
// （都 idle／done／不見了就停；再下指令時會重新開始）
function needsHerdrPoll(now) {
  if (paneOpen && tab === 'herdr') return true
  // 任務分頁要知道哪條 lane 卡在對話框
  if (paneOpen && tab === 'tasks' && lanes.some((l) => l.pane)) return true
  if (!Object.keys(herdrTargets).length) return false
  if (now - herdrCommandAt < HERDR_GRACE_MS) return true
  return herdrAgents.some((a) => isCommanded(a) && (a.agent_status === 'working' || a.agent_status === 'blocked'))
}

function isCommanded(agent) {
  return Object.keys(herdrTargets).some((t) => t === agent.pane_id || (agent.name && t === agent.name))
}

async function saveHerdr($) {
  if (sessionId) await $.store.set('herdr:' + sessionId, herdrTargets)
}

// lane 模式的交接：只帶一覽與自己的狀態，細節需要時再讀（不再整節附上交接文件）
// 交接說明與指示要用到的路徑
function briefingContext() {
  return { tasksDir, selfLane, handoffFile, handoffSection, memoryDir, compactFile, projectSettingsFile, handoffAt: handoff.mtimeMs ? clock(handoff.mtimeMs) : '' }
}

function laneBriefing(now) {
  const lines = T.laneBriefing(briefingContext())
  if (lanesError) lines.push('(' + lanesError + ')')
  for (const l of lanes) {
    const { done, total, percent } = laneProgress(l)
    lines.push(LANE_LOOK[l.state][0] + ' ' + T.laneLine(l.lane, l.title, percent, done, total, laneStanding(l, now)))
  }
  const self = lanes.find((l) => l.lane === selfLane)
  if (self) {
    lines.push('', T.laneSelfSteps(selfLane))
    for (const s of self.steps) lines.push(STEP_ICONS[s.state] + ' ' + s.id + ' ' + s.title)
    if (self.needs) lines.push(T.laneSelfNeeds(self.needs))
    for (const n of self.notes ?? []) lines.push('• ' + n)
  }
  return lines.join('\n')
}

// 附在 prompt 後面給 Claude 看的說明（使用者看不到）
function briefing(now) {
  if (tasksDir) return laneBriefing(now)
  const lines = T.briefing(briefingContext())
  if (handoff.text) {
    lines.push('', T.briefingHandoff, '', '<handoff>', handoff.text.slice(0, 20000), '</handoff>')
  }
  return lines.join('\n')
}

async function loadMemories($) {
  try {
    if (!memoryDir) await resolvePaths($)
    if (!(await $.fs.exists(memoryDir))) {
      memories = []
      return
    }
    const entries = await $.fs.list(memoryDir)
    const files = entries.filter((x) => x.kind === 'file' && x.name.endsWith('.md') && x.name !== 'MEMORY.md')
    const list = []
    for (const f of files) {
      list.push(parseMemory(f.name, await $.fs.read(memoryDir + '/' + f.name)))
    }
    memories = list.sort((a, b) => a.name.localeCompare(b.name))
  } catch (err) {
    note = T.memoryReadFail(String(err))
  }
  $.ui.invalidate('ui.render')
}

async function loadHandoff($) {
  try {
    if (!handoffFile) await resolvePaths($)
    if (!(await $.fs.exists(handoffFile))) {
      handoff = { text: '', mtimeMs: 0 }
      return
    }
    const st = await $.fs.stat(handoffFile)
    const raw = await $.fs.read(handoffFile)
    handoff = { text: handoffSection ? extractSection(raw, handoffSection) : raw, mtimeMs: st.mtimeMs }
  } catch {
    handoff = { text: '', mtimeMs: 0 }
  }
  $.ui.invalidate('ui.render')
}

async function saveTimes($) {
  if (!sessionId) return
  await $.store.set('times:' + sessionId, { lastRequestAt, lastUserAt, activated })
}

function handoffPrompt(remainingMs) {
  const head = T.handoffPrefix + ' ' + T.handoffHead(Math.max(1, Math.round(remainingMs / 60000)))
  const steps = tasksDir ? T.handoffLane(briefingContext()) : T.handoffDocSteps(briefingContext())
  return [head, ...steps].join('\n')
}

function compactInstructions() {
  return tasksDir ? T.compactLane(tasksDir) : T.compactDoc(handoffFile, handoffSection)
}

async function startHandoff($, remainingMs) {
  phase = 'handoff'
  handoffTurnId = ''
  handoffSentAt = await $.clock.now()
  // 交接前把還沒整理的對話整理掉（另一個請求，不佔主對話；失敗下次再整理）
  if (distillOn && talk.humans > 0) void distill($, T.distillWhy.handoff)
  note = T.handoffSent
  $.ui.toast(T.handoffToast)
  $.ui.invalidate('ui.render')
  // 不 await：submit 會等到 session 閒置才開始新的一輪；被擋或失敗時退回 idle，免得一直卡在「交接中…」
  void $.prompt.submit({ text: handoffPrompt(remainingMs) }).then(
    (r) => {
      if (r?.drop !== undefined) failHandoff($, T.handoffBlocked(r.drop))
    },
    (err) => failHandoff($, T.handoffSubmitFail(String(err))),
  )
}

function failHandoff($, message) {
  if (phase !== 'handoff') return
  phase = 'idle'
  note = message
  $.ui.toast(message)
  $.ui.invalidate('ui.render')
}

// 「立即交接」按鈕與 /handoff 共用
async function handoffNow($) {
  // 交接指示送出超過一分鐘，那一輪卻一直沒開始、現在也沒在跑：當作沒送到，重送
  if (phase === 'handoff' && !handoffTurnId && !working && (await $.clock.now()) - handoffSentAt > 60000) phase = 'idle'
  if (phase !== 'idle') {
    $.ui.toast(phase === 'handoff' ? T.alreadyHandingOff : T.alreadyCompacting)
    return
  }
  const remaining = lastRequestAt ? lastRequestAt + ttlMs() - (await $.clock.now()) : LEAD_MS
  await startHandoff($, Math.max(remaining, 60000))
}

async function runCompact($) {
  try {
    const r = await $.session.compact({ instructions: compactInstructions() })
    note = r.skip ? T.compactSkipped(r.skip) : T.compactDone
    phase = 'idle'
    armed = false
  } catch (err) {
    // 一輪還在跑時 compact 會被拒絕，稍後重試
    compactTries += 1
    if (compactTries < 6) {
      $.clock.after(3000, () => runCompact($))
      return
    }
    note = T.compactFail(String(err))
    phase = 'idle'
    armed = false
  }
  $.ui.invalidate('ui.render')
}

async function checkTrigger($) {
  // 只有輸入過 /board 的 session（主控 session）才自動交接
  if (!activated || !auto || !armed || phase !== 'idle' || !lastRequestAt) return
  // 5 分鐘的快取每次停下來想一下就會過期，自動交接只會一直打斷，不做
  if (cacheTtl !== '1h') return
  const now = await $.clock.now()
  const remaining = lastRequestAt + ttlMs() - now
  // 還早，或已經過期（過期後壓縮就沒有省快取的意義）
  if (remaining > LEAD_MS || remaining <= 0) return
  if (!working && now - lastUserAt > activeWindowMs) return
  const percent = usage?.context?.percent ?? 0
  if (percent < MIN_CONTEXT_PERCENT) {
    armed = false
    note = T.contextTooSmall(Math.round(percent))
    $.ui.invalidate('ui.render')
    return
  }
  await startHandoff($, remaining)
}

// auto：先看 Claude Code 的 language 設定（例如「繁體中文」「English」），沒設再看 LANG 之類的環境變數
// 目前只有繁體中文與英文；任何中文都用繁體中文，其他語言用英文
async function detectLanguage($) {
  if (languageSetting in I18N) return languageSetting
  const isChinese = (s) => /中文|漢|汉|chinese|^zh/i.test(s)
  try {
    const { language } = await $.settings.read()
    if (typeof language === 'string' && language.trim()) return isChinese(language.trim()) ? 'zh-TW' : 'en'
  } catch {
    // 讀不到設定就看環境變數
  }
  const locale = (await $.env.get('LC_ALL')) || (await $.env.get('LC_MESSAGES')) || (await $.env.get('LANG')) || ''
  if (locale) return isChinese(locale) ? 'zh-TW' : 'en'
  return 'en'
}

function ttlMs() {
  return CACHE_TTLS[cacheTtl] ?? HOUR
}

async function refreshUsage($) {
  try {
    usage = await $.session.usage()
    model = await $.session.model()
  } catch {
    // 保留上一次的數值
  }
}

// ---------- 自動整理筆記 ----------

// 對話紀錄依專案存，換 session（/clear、重開）後沒整理到的部分下次接著整理
async function talkKey($) {
  return 'talk:' + (await $.session.root()).replace(/[^A-Za-z0-9]/g, '-')
}

async function loadTalk($) {
  const saved = await $.store.get(await talkKey($))
  if (saved && Array.isArray(saved.items)) talk = { items: saved.items, humans: Number(saved.humans) || 0 }
  const last = await $.store.get('distill-last')
  if (last && typeof last === 'object') lastDistill = last
}

async function saveTalk($) {
  await $.store.set(await talkKey($), talk)
}

async function recordTalk($, role, text) {
  const value = String(text ?? '').trim()
  if (!value) return
  const items = [...talk.items, { role, text: value }]
  talk = { items: items.length > TALK_MAX ? items.slice(-TALK_MAX) : items, humans: talk.humans + (role === 'user' ? 1 : 0) }
  await saveTalk($)
}

// 把上次整理之後的對話交給整理模型，寫進記憶資料夾。失敗時對話留著，下次再整理
async function distill($, why) {
  if (distilling || !distillOn) return
  const items = talk.items
  const userTexts = items.filter((t) => t.role === 'user').map((t) => t.text)
  if (!userTexts.length) {
    if (why === T.distillWhy.manual) $.ui.toast(T.distillNothing)
    return
  }
  distilling = true
  note = T.distillRunning(why)
  $.ui.invalidate('ui.render')
  const now = await $.clock.now()
  const today = new Date(now).toISOString().slice(0, 10)
  const result = { at: now, why, added: [], confirmed: [], rejected: [], error: '' }
  try {
    await loadMemories($)
    if (!(await $.fs.exists(memoryDir))) throw new Error(T.memoryDirMissing(memoryDir))
    const r = await $.model.complete({
      model: notesModel,
      prompt: T.distillPrompt(memories, items),
      effort: 'low',
      maxTokens: 4000,
      timeoutMs: 180000,
    })
    if (!r.isAnswered) throw new Error(T.modelNoReply(r.reason + (r.error ? ' ' + r.error : '')))
    const byName = new Map(memories.map((m) => [m.name, m]))
    const { adds, confirms, rejected } = parseActions(r.text, new Set(byName.keys()), userTexts)
    result.rejected = rejected
    for (const c of confirms) {
      const m = byName.get(c.name)
      const path = memoryDir + '/' + m.file
      await $.fs.write(path, setMeta(await $.fs.read(path), { count: m.count + 1, last_seen: today }))
      result.confirmed.push(c.name)
    }
    if (adds.length) {
      for (const a of adds) await $.fs.write(memoryDir + '/' + a.name + '.md', newMemoryFile(a, today))
      const indexPath = memoryDir + '/MEMORY.md'
      const index = (await $.fs.exists(indexPath)) ? await $.fs.read(indexPath) : ''
      const lines = adds.map(indexLine).join('\n')
      await $.fs.write(indexPath, index.trim() ? index.replace(/\s*$/, '\n') + lines + '\n' : lines + '\n')
      result.added = adds.map((a) => a.name)
    }
    // 整理過的部分丟掉；整理期間新增的留著
    const rest = talk.items.slice(items.length)
    talk = { items: rest, humans: rest.filter((t) => t.role === 'user').length }
    await saveTalk($)
    await loadMemories($)
    note = T.distillDone(result.added.length, result.confirmed.length)
    // 次數變多了：看看有沒有寫成文字還擋不住、該起草守門的
    if (result.confirmed.length) $.clock.after(0, () => draftGuards($, false))
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err)
    note = T.distillFail(result.error)
  } finally {
    distilling = false
    lastDistill = result
    await $.store.set('distill-last', result)
    $.ui.invalidate('ui.render')
  }
}

// ---------- 守門 ----------

async function loadGuards($) {
  try {
    if (!guardsFile) await resolvePaths($)
    if (!(await $.fs.exists(guardsFile))) {
      guards = []
    } else {
      const parsed = JSON.parse(await $.fs.read(guardsFile))
      guards = Array.isArray(parsed) ? parsed.filter((g) => g && typeof g.id === 'number' && typeof g.match === 'string') : []
    }
    const hits = await $.store.get('guard-hits:' + guardsFile)
    guardHitCounts = hits && typeof hits === 'object' ? hits : {}
  } catch (err) {
    note = T.guardsReadFail(String(err))
  }
}

async function saveGuards($, list) {
  guards = list
  await $.fs.write(guardsFile, JSON.stringify(list, null, 2) + '\n')
  $.ui.invalidate('ui.render')
}

// 寫成文字還擋不住的要求，請模型起草守門；草稿要使用者同意才生效
async function draftGuards($, manual) {
  if (drafting) return T.guardBusy
  await loadMemories($)
  await loadGuards($)
  const rules = guardCandidates(memories, guards)
  if (!rules.length) return T.guardNoCandidates
  drafting = true
  try {
    const r = await $.model.complete({
      model: notesModel,
      prompt: T.guardPrompt(rules, [...toolsSeen]),
      effort: 'low',
      maxTokens: 3000,
      timeoutMs: 180000,
    })
    if (!r.isAnswered) throw new Error(T.modelNoReply(r.reason))
    const { out, rejected } = parseGuards(r.text, new Set(rules.map((m) => m.name)))
    if (!out.length) return T.guardNoneFit(rejected.length)
    const drafts = withProposals(out, guards, await $.clock.now())
    await saveGuards($, [...guards, ...drafts])
    const text = T.guardDrafted(drafts.length)
    if (!manual) $.ui.toast(text)
    return text
  } catch (err) {
    return T.guardDraftFail(err instanceof Error ? err.message : String(err))
  } finally {
    drafting = false
  }
}

async function recordGuardHit($, id) {
  guardHitCounts = { ...guardHitCounts, [id]: (guardHitCounts[id] ?? 0) + 1 }
  await $.store.set('guard-hits:' + guardsFile, guardHitCounts)
}

async function guardCommand($, args) {
  const [action = '', idText = '', mode = ''] = String(args ?? '').trim().split(/\s+/)
  await loadGuards($)
  if (!action || action === 'list') return guards.length ? T.guardList(guards, guardHitCounts) : T.guardNone(GUARD_MIN_COUNT)
  if (action === 'suggest') return await draftGuards($, true)
  const updated = applyGuardChange(guards, action, Number(idText), mode)
  if (!updated) return T.guardUsage
  await saveGuards($, updated)
  return guards.length ? T.guardList(guards, guardHitCounts) : T.guardNone(GUARD_MIN_COUNT)
}

// 工具呼叫結束後的防呆觀察（失敗一律放行原結果，絕不丟例外、不擋呼叫）：
// 同一個工具連續兩次因同樣原因失敗，在第 2 次的結果後面附提醒；記下這一輪的改檔與驗證；帶出回覆語言提醒
function watchCall(e, r) {
  try {
    if (!r || r.deny !== undefined) return r
    const failed = r.isError === true
    const agent = e.agentId ?? ''
    // 只記主對話自己的呼叫：子代理改檔或驗證不算主對話這一輪
    if (doneCheckOn && !agent) noteCall(work, e.tool, e, failed)
    const extra = []
    const text = r.text ?? (typeof r.result === 'string' ? r.result : undefined)
    if (retryNudge && trackFailure(streaks, agent + '|' + e.tool, failed, text)) extra.push(T.retryNudge(e.tool, briefOf(text)))
    const lang = agent ? undefined : takePending(reply)
    if (lang) extra.push(lang)
    return extra.length ? { ...r, context: [...(r.context ?? []), ...extra] } : r
  } catch {
    return r
  }
}

// 沒開就打開，開著就關掉（/board 與輸入框上方的按鈕共用）
async function toggleBoard($) {
  if (paneOpen) {
    paneOpen = false
    await $.ui.close({ id: PANE })
    $.ui.invalidate('ui.render')
    return
  }
  await loadMemories($)
  await loadHandoff($)
  await loadLanes($)
  await refreshHerdr($)
  // columns：停靠在右側時想要的寬度（使用者拖曳調整過的寬度優先；放在輸入框上方時不適用）
  await $.ui.open({ id: PANE, title: T.paneTitle, focus: true, columns: 50 })
  paneOpen = true
  if (!activated) {
    activated = true
    await saveTimes($)
  }
  $.ui.invalidate('ui.render')
}

export function register(on, options) {
  // userConfig 的值；空字串視為未設定，用預設值
  if (typeof options?.memory_dir === 'string' && options.memory_dir.trim()) memorySetting = options.memory_dir
  if (typeof options?.handoff_path === 'string' && options.handoff_path.trim()) handoffSetting = options.handoff_path
  if (typeof options?.brief_on_start === 'boolean') briefOnStart = options.brief_on_start
  if (options?.cache_ttl in CACHE_TTLS) cacheTtl = options.cache_ttl
  if (typeof options?.launcher_button === 'boolean') launcherButton = options.launcher_button
  const awayHours = Number(options?.away_hours)
  if (awayHours > 0) activeWindowMs = awayHours * HOUR
  if (options?.language in I18N || options?.language === 'auto') languageSetting = options.language
  if (typeof options?.retry_nudge === 'boolean') retryNudge = options.retry_nudge
  if (typeof options?.done_check === 'boolean') doneCheckOn = options.done_check
  if (['auto', 'off', 'zh-TW', 'zh-CN', 'en', 'ja'].includes(options?.reply_language)) replyLanguage = options.reply_language
  if (typeof options?.distill === 'boolean') distillOn = options.distill
  if (Number(options?.distill_every) > 0) distillEvery = Number(options.distill_every)
  if (['sonnet', 'haiku', 'opus'].includes(options?.notes_model)) notesModel = options.notes_model

  // 切換模型時引擎會告知目前的快取 TTL，以它為準
  on('classic.PostModelSwitch', async ($, e, next) => {
    if (e.cache_ttl in CACHE_TTLS) cacheTtl = e.cache_ttl
    $.ui.invalidate('ui.render')
    return next(e)
  })

  on('session.start', async ($, e, next) => {
    T = I18N[await detectLanguage($)]
    sessionId = await $.session.id()
    // 回覆語言提醒的目標（和介面語言分開：介面只有中英，回覆語言還認得簡中與日文）
    if (replyLanguage === 'auto') {
      try {
        replyTarget = replyLangOfSetting((await $.settings.read()).language)
      } catch {
        replyTarget = undefined
      }
    } else {
      replyTarget = replyLanguage === 'off' ? undefined : replyLanguage
    }
    const savedAuto = await $.store.get('auto')
    if (typeof savedAuto === 'boolean') auto = savedAuto
    const savedWrap = await $.store.get('wrap')
    if (typeof savedWrap === 'boolean') wrapLong = savedWrap
    const times = await $.store.get('times:' + sessionId)
    if (times && typeof times === 'object') {
      lastRequestAt = Number(times.lastRequestAt) || 0
      lastUserAt = Number(times.lastUserAt) || 0
      activated = times.activated === true
    }
    await refreshUsage($)
    await loadMemories($)
    await loadHandoff($)
    await loadCompact($)
    await loadLanes($)
    await loadTalk($)
    await loadGuards($)
    if (tasksDir && tab === 'progress') tab = 'tasks'

    herdrEnv = (await $.env.get('HERDR_ENV')) === '1'
    herdrBin = (await $.env.get('HERDR_BIN_PATH')) || 'herdr'
    if (herdrEnv) {
      herdrSelf = (await $.env.get('HERDR_PANE_ID')) || ''
      herdrWorkspace = (await $.env.get('HERDR_WORKSPACE_ID')) || ''
      const savedTargets = await $.store.get('herdr:' + sessionId)
      if (savedTargets && typeof savedTargets === 'object') herdrTargets = savedTargets
      // 先查一次，之後是否繼續查看指揮過的 agent 還在不在忙
      if (Object.keys(herdrTargets).length) await refreshHerdr($)
    }

    let tick = 0
    $.clock.every(1000, async () => {
      tick += 1
      if (tick % 5 === 0) await refreshUsage($)
      if (herdrEnv && tick % 5 === 0 && needsHerdrPoll(await $.clock.now())) await refreshHerdr($)
      // lane 在別的 session 寫狀態檔：看板開著時 5 秒看一次，關著時 30 秒（要能提醒「等你」）
      if (tasksDir && tick % (paneOpen ? 5 : 30) === 0) await loadLanes($)
      // 正在看某條 lane 的子頁：3 秒更新一次即時畫面
      const page = route[route.length - 1]
      if (paneOpen && tab === 'tasks' && page?.view === 'lane' && tick % 3 === 0) await refreshScreen($, page.lane)
      await checkTrigger($)
      // 看板關著時不用重畫
      if (paneOpen) $.ui.invalidate('ui.render')
    })

    // 不自動開啟，只有輸入 /board 才會出現
    try {
      await $.command.register({ name: 'board', description: T.cmdBoard, immediate: true })
    } catch (err) {
      note = T.registerFail('board', String(err))
    }
    // 非全螢幕時滑鼠點不到看板按鈕，用指令觸發立即交接
    try {
      await $.command.register({ name: 'handoff', description: T.cmdHandoff, immediate: true })
    } catch (err) {
      note = T.registerFail('handoff', String(err))
    }
    try {
      await $.command.register({ name: 'distill', description: T.cmdDistill, immediate: true })
    } catch (err) {
      note = T.registerFail('distill', String(err))
    }
    try {
      await $.command.register({ name: 'guard', description: T.cmdGuard, immediate: true })
    } catch (err) {
      note = T.registerFail('guard', String(err))
    }
    return next(e)
  })

  on('command.run', { command: 'board' }, async ($) => {
    await toggleBoard($)
    return {}
  })

  on('command.run', { command: 'handoff' }, async ($) => {
    // command.run 裡不能直接 prompt.submit（會等這個 hook 佔住的那一輪），排到 hook 結束後
    $.clock.after(0, () => handoffNow($))
    return {}
  })

  on('command.run', { command: 'distill' }, async ($) => {
    if (!distillOn) return { text: T.distillOff }
    if (distilling) return { text: T.distillBusy }
    $.clock.after(0, () => distill($, T.distillWhy.manual))
    return { text: T.distillStarted(talk.humans) }
  })

  on('command.run', { command: 'guard' }, async ($, e) => ({ text: await guardCommand($, e.args) }))

  // 輸入框上方的一顆按鈕：看板關著時才出現，點了打開（狀態列是外部指令輸出的文字，放不了按鈕）
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!launcherButton || paneOpen || e.props.hasSurvey) return next(e)
    const { Box, Button } = $.ui.resolve(e)
    return Box({
      flexDirection: 'row',
      justifyContent: 'flex-end',
      children: [Button({ key: 'open-board', label: T.launcher, plain: true, dimColor: true, onPress: () => toggleBoard($) })],
    })
  })

  // 使用者用 Esc、Ctrl+X X 等方式關掉看板時同步狀態
  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) {
      paneOpen = false
      $.ui.invalidate('ui.render')
    }
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const kind = e.origin?.kind
    if (kind === 'composer' || kind === 'bridge') {
      lastUserAt = await $.clock.now()
      // 使用者有新動作，重新允許下一次自動交接
      armed = true
      await saveTimes($)
      // 使用者的新訊息開始新的一輪：改檔與驗證重新算
      work = freshWork()
      // 斜線指令不是對 Claude 說的話，不記；記錄失敗不影響送出
      try {
        if (distillOn && !String(e.text ?? '').trimStart().startsWith('/')) await recordTalk($, 'user', e.text)
      } catch {}
      // 上一輪最後的回答語言跑掉，提醒跟著這則訊息帶給 Claude
      const extra = takeNext(reply)
      if (briefOnStart && needsBriefing) {
        needsBriefing = false
        await loadHandoff($)
        await loadLanes($)
        await loadMemories($)
        await loadGuards($)
        const promote = promoteCandidates(memories)
        const drafts = guards.filter((g) => g.state === 'proposed').slice(0, GUARD_ASK_ITEMS)
        extra.unshift(
          briefing(await $.clock.now()),
          ...(promote.length ? [T.promote(promote, memoryDir)] : []),
          ...(drafts.length ? [T.guardAsk(drafts, guardsFile)] : []),
        )
      }
      if (extra.length) return next({ ...e, context: [...(e.context ?? []), ...extra] })
    }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (!e.agentId) {
      working = true
      turnStartedAt = await $.clock.now()
      toolCalls = 0
      currentTool = ''
      // 只認自己送出的交接指示；使用者剛好先送出的那一輪不算
      // 引擎會在外掛送的訊息前加「The baton plugin sent a message: 」，所以不能用 startsWith
      if (phase === 'handoff' && !handoffTurnId && HANDOFF_PREFIXES.some((p) => String(e.text ?? '').includes(p))) handoffTurnId = e.turnId
      $.ui.invalidate('ui.render')
    }
    return next(e)
  })

  // 每次主對話送出請求後，快取就重新計時
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    if (!e.agentId) {
      lastRequestAt = await $.clock.now()
      await saveTimes($)
      // 主對話這一步的說明不是目標語言：還要呼叫工具就跟著下一個工具結果提醒，否則跟著使用者的下一則訊息
      try {
        if (replyTarget && result?.answer) noteStep(reply, result.answer, (result.toolUses?.length ?? 0) > 0, replyTarget)
      } catch {}
    }
    return result
  })

  on('turn.complete', async ($, e, next) => {
    if (!e.agentId) {
      working = false
      currentTool = ''
      if (e.answer) lastAnswer = e.answer
      // 被中斷的回合沒有 Stop：清掉這一輪的改檔紀錄，免得算到下一輪
      if (e.isAborted) work = freshWork()
      if (distillOn && e.answer && !(phase === 'handoff' && e.turnId === handoffTurnId)) {
        try {
          await recordTalk($, 'assistant', e.answer)
          // 每 distill_every 則使用者訊息，趁快取還熱整理一次
          if (talk.humans >= distillEvery && !distilling) $.clock.after(0, () => distill($, T.distillWhy.every(distillEvery)))
        } catch {}
      }
      await refreshUsage($)
      if (phase === 'handoff' && handoffTurnId && e.turnId === handoffTurnId) {
        await loadHandoff($)
        if (e.isAborted) {
          phase = 'idle'
          armed = false
          note = T.handoffAborted
        } else {
          phase = 'compacting'
          compactTries = 0
          note = T.handoffWritten
          // 等這一輪完全結束再壓縮
          $.clock.after(1500, () => runCompact($))
        }
      }
      $.ui.invalidate('ui.render')
    }
    return next(e)
  })

  // 說完成了，但這一輪改檔之後沒跑任何測試或檢查（或跑了沒過）：擋下這次停止，請 Claude 先驗證（每輪最多一次）
  on('classic.Stop', async ($, e, next) => {
    const out = await next(e)
    // 別的 Stop hook 已經要求繼續：回合其實沒結束，等真正停下的那次再判斷
    if (out?.block !== undefined || e.agent_id !== undefined) return out
    let kind
    try {
      if (doneCheckOn) kind = doneCheck(work, e.last_assistant_message, e.stop_hook_active === true)
    } catch {}
    if (kind) return { ...out, block: T.doneCheck[kind] }
    work = freshWork()
    return out
  })

  // 壓縮後舊的快取前綴就不再使用，倒數歸零，等下一次請求重新建立
  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    if (!e.agentId && e.trigger !== 'precompute' && !result.skip) {
      lastRequestAt = 0
      needsBriefing = true
      await saveTimes($)
      await refreshUsage($)
      // 摘要是壓縮後的第一則訊息；PostCompact 來的 compact_summary 會再覆寫
      compactInfo = {
        summary: String(result.messages?.[0]?.text ?? '').trim(),
        at: await $.clock.now(),
        tokensBefore: result.tokensBefore ?? 0,
        tokensAfter: result.tokensAfter ?? 0,
      }
      if (compactInfo.summary) await saveCompact($)
      $.ui.invalidate('ui.render')
    }
    return result
  })

  on('classic.PostCompact', async ($, e, next) => {
    if (!e.agent_id && e.compact_summary) {
      compactInfo = { ...compactInfo, summary: e.compact_summary.trim(), at: compactInfo.at || (await $.clock.now()) }
      needsBriefing = true
      await saveCompact($)
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    if (!e.agentId) {
      currentTool = toolLabel(e)
      toolCalls += 1
      if (e.tool === 'TodoWrite' && Array.isArray(e.todos)) todos = e.todos
      if (e.tool === 'TaskUpdate' && e.taskId && tasks[e.taskId] && e.status) {
        tasks = { ...tasks, [e.taskId]: { ...tasks[e.taskId], status: e.status } }
      }
      $.ui.invalidate('ui.render')
    }
    toolsSeen.add(e.tool)
    // 守門：啟用中的守門命中時，deny 直接擋下，remind 照常執行、在結果後面附提醒；檢查本身出錯就放行
    let hit
    try {
      hit = findGuardHit(guards, e.tool, e)
    } catch {}
    if (hit) {
      try {
        await recordGuardHit($, hit.id)
      } catch {}
      if (hit.mode === 'deny') {
        $.ui.toast(T.guardDenyToast(hit.id, e.tool, hit.rule))
        return { deny: T.guardHead(hit) + '\n' + T.guardDenyHint(hit.id) }
      }
    }
    let result = watchCall(e, await next(e))
    if (hit && result && result.deny === undefined) result = { ...result, context: [...(result.context ?? []), T.guardHead(hit)] }
    if (herdrEnv && !e.agentId && e.tool === 'Bash' && typeof e.command === 'string' && /\bherdr/.test(e.command)) {
      const now = await $.clock.now()
      const found = parseHerdr(e.command)
      // pane split 建立的新 pane 從回傳的 JSON 讀 pane_id
      if (/\bherdr(?:\.exe)?\s+pane\s+split\b/.test(e.command)) {
        const m = JSON.stringify(result ?? '').match(/\\?"pane_id\\?"\s*:\s*\\?"(\w+:p\w+)/)
        if (m) found.push({ target: m[1], action: 'split', detail: '' })
      }
      for (const f of found) {
        if (f.target === herdrSelf) continue
        herdrTargets = { ...herdrTargets, [f.target]: { ...f, detail: clip(f.detail, 120), at: now } }
      }
      if (found.length) {
        herdrCommandAt = now
        await saveHerdr($)
        await refreshHerdr($)
      }
    }
    if ((e.tool === 'Write' || e.tool === 'Edit') && typeof e.file_path === 'string') {
      const path = e.file_path.replace(/\\/g, '/')
      const dir = path.slice(0, path.lastIndexOf('/'))
      if (memoryDir && samePath(dir, memoryDir)) await loadMemories($)
      if (handoffFile && samePath(path, handoffFile)) await loadHandoff($)
      if (tasksDir && samePath(dir, tasksDir)) await loadLanes($)
      // 使用者同意後 Claude 直接改守門檔的 state
      if (guardsFile && samePath(path, guardsFile)) await loadGuards($)
      // 改了專案覆寫檔：重新決定路徑並重讀
      if (projectSettingsWatch.some((p) => samePath(path, p))) {
        await resolvePaths($)
        await loadMemories($)
        await loadHandoff($)
        await loadCompact($)
        await loadLanes($)
      }
    }
    return result
  })

  on('classic.TaskCreated', async ($, e, next) => {
    tasks = { ...tasks, [e.task_id]: { subject: e.task_subject, status: 'pending' } }
    $.ui.invalidate('ui.render')
    return next(e)
  })

  on('classic.TaskCompleted', async ($, e, next) => {
    tasks = { ...tasks, [e.task_id]: { subject: e.task_subject, status: 'completed' } }
    $.ui.invalidate('ui.render')
    return next(e)
  })

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE) return next(e)
    const { Box, Text, Button, Markdown, Input } = $.ui.resolve(e)
    const redraw = () => $.ui.invalidate('ui.render')
    const cols = e.props?.bodyColumns ?? 48
    const now = await $.clock.now()

    // 去掉值為 undefined 的 prop，避免元素驗證失敗
    const line = (children, props = {}) =>
      Text({ wrap: 'wrap', ...Object.fromEntries(Object.entries(props).filter(([, v]) => v !== undefined)), children })
    // 長文字：依「換行」開關決定換行或截成一行（路徑用 truncate-middle 保留頭尾）
    const longLine = (text, props = {}, cut = 'truncate-end') => line([text], { ...props, wrap: wrapLong ? 'wrap' : cut })
    // 一列多個元素：放不下時整顆移到下一行
    const row = (children, columnGap = 2) => Box({ flexDirection: 'row', flexWrap: 'wrap', columnGap, children })
    const blank = () => Text({ children: [' '] })
    const rule = () => Text({ dimColor: true, wrap: 'truncate-end', children: ['─'.repeat(Math.max(10, cols))] })

    // 開關按鈕：開啟時括號綠色，關閉時整顆變暗（Button 本身不能上色）
    const toggle = (key, label, isOn, onPress) =>
      Box({
        flexDirection: 'row',
        flexShrink: 0,
        children: [
          line(['[ '], isOn ? { color: 'green' } : { dimColor: true }),
          Button({ key, label, plain: true, dimColor: !isOn, onPress }),
          line([' ]'], isOn ? { color: 'green' } : { dimColor: true }),
        ],
      })

    const tabButton = (name, label) =>
      Button({
        key: 'tab-' + name,
        label,
        plain: true,
        dimColor: tab !== name,
        onPress: () => {
          tab = name
          redraw()
        },
      })

    // 分頁 1：進度
    const progressBody = () => {
      const rows = []
      if (working) {
        rows.push(line([T.runningTools(duration(now - turnStartedAt), toolCalls)], { color: 'green' }))
        if (currentTool) rows.push(longLine('  ' + currentTool, { dimColor: true }))
      } else {
        rows.push(line([T.idleState], { dimColor: true }))
      }

      const stats = []
      const percent = usage?.context?.percent
      if (typeof percent === 'number') stats.push(T.context(Math.round(percent)))
      for (const r of usage?.rateLimits ?? []) {
        const label = r.kind === 'five_hour' ? '5h' : r.kind === 'seven_day' ? '7d' : r.kind
        stats.push(label + ' ' + Math.round(r.percentUsed) + '%')
      }
      if (usage?.cost) stats.push('$' + usage.cost.usd.toFixed(2))
      if (stats.length) rows.push(line([stats.join(' · ')]))

      const taskList = todos.length
        ? todos.map((t) => ({ subject: t.content, status: t.status, active: t.activeForm }))
        : Object.values(tasks)
      if (taskList.length) {
        const done = taskList.filter((t) => t.status === 'completed').length
        rows.push(blank(), line([T.tasksHeader(done, taskList.length) + '  ' + bar(done / taskList.length, 12)], { bold: true }))
        for (const t of taskList) {
          const mark = t.status === 'completed' ? '✔' : t.status === 'in_progress' ? '◐' : '○'
          const text = t.status === 'in_progress' && t.active ? t.active : t.subject
          rows.push(
            longLine(mark + ' ' + text, {
              dimColor: t.status === 'completed',
              color: t.status === 'in_progress' ? 'yellow' : undefined,
            }),
          )
        }
      }

      if (lastAnswer) {
        rows.push(blank(), line([T.lastReply], { bold: true }), longLine(clip(lastAnswer, cols * 3), { dimColor: true }))
      }

      if (compactInfo.summary) {
        const k = (n) => (n >= 1000 ? Math.round(n / 1000) + 'k' : String(n))
        const tokens = compactInfo.tokensBefore ? ' · ' + k(compactInfo.tokensBefore) + ' → ' + k(compactInfo.tokensAfter) + ' tokens' : ''
        rows.push(
          blank(),
          Button({
            key: 'toggle-compact',
            label: (compactOpen ? '▾ ' : '▸ ') + T.compactKept(clock(compactInfo.at) + tokens),
            plain: true,
            onPress: () => {
              compactOpen = !compactOpen
              redraw()
            },
          }),
          longLine(compactFile, { dimColor: true }, 'truncate-middle'),
        )
        if (compactOpen) rows.push(Markdown({ key: 'compact-summary', text: compactInfo.summary.slice(0, 8000) }))
      }

      rows.push(blank())
      if (handoff.text) {
        rows.push(
          line([T.handoffDoc(clock(handoff.mtimeMs)) + (handoffSection ? T.onlySection(handoffSection) : '')], { bold: true }),
          longLine(handoffFile, { dimColor: true }, 'truncate-middle'),
          Markdown({ key: 'handoff', text: handoff.text.slice(0, 6000) }),
        )
      } else {
        rows.push(line([T.noHandoff], { dimColor: true }), longLine(handoffFile, { dimColor: true }, 'truncate-middle'))
      }
      return rows
    }

    // 一則記憶：標題可展開全文
    const today = new Date(now).toISOString().slice(0, 10)
    const memItem = (m, prefix = '') => {
      const isOpen = expanded === m.file
      const overdue = m.reviewBy && m.reviewBy < today
      const tags = [
        m.count > 1 ? T.countTag(m.count) : '',
        m.promoted && m.promoted !== 'declined' ? T.promotedTag : '',
        m.lane ? '〔' + m.lane + '〕' : '',
        overdue ? T.dueReview : '',
      ].join('')
      const rows = [
        Button({
          key: prefix + 'mem-' + m.file,
          label: (isOpen ? '▾ ' : '▸ ') + m.name + tags,
          plain: true,
          onPress: () => {
            expanded = isOpen ? '' : m.file
            redraw()
          },
        }),
      ]
      if (m.description) rows.push(longLine('  ' + m.description, { dimColor: true }))
      if (isOpen && m.body) rows.push(Markdown({ key: prefix + 'mem-body-' + m.file, text: m.body.slice(0, 6000) }))
      return rows
    }

    // 分頁：記憶，依 layer 分層；沒標 layer 的歸「未分層」，裡面再依類型分組
    const memoryBody = () => {
      const rows = [
        row([
          Text({ dimColor: true, children: [T.memoryCount(memories.length)] }),
          Button({
            key: 'reload-memory',
            label: T.refresh,
            onPress: () => loadMemories($),
          }),
        ]),
      ]
      rows.push(longLine(memoryDir, { dimColor: true }, 'truncate-middle'))
      // 自動整理筆記的狀態與「立即整理」
      if (distillOn) {
        const d = lastDistill
        const status = distilling ? T.distilling : !d ? T.neverDistilled : d.error ? T.lastDistillFail(clock(d.at), d.why, d.error) : T.lastDistill(clock(d.at), d.why, d)
        rows.push(
          row([
            Text({ dimColor: true, children: [status + T.untilNext(Math.max(0, distillEvery - talk.humans))] }),
            Button({ key: 'distill-now', label: T.distillNow, onPress: () => distill($, T.distillWhy.manual) }),
          ]),
        )
        if (d && !d.error && (d.added.length || d.confirmed.length)) rows.push(longLine('  ' + [...d.added.map((n) => '+' + n), ...d.confirmed.map((n) => '↑' + n)].join(' · '), { dimColor: true }))
      }
      if (guards.length) {
        const count = (s) => guards.filter((g) => g.state === s).length
        rows.push(line([T.guardSummary(count('on'), count('proposed'), count('off'))], { dimColor: true }))
      }
      if (!memories.length) {
        rows.push(line([T.noMemories], { dimColor: true }))
        return rows
      }
      for (const key of [...LAYERS, 'none']) {
        const [label, hint] = T.layers[key]
        const items = memories.filter((m) => (key === 'none' ? !LAYERS.includes(m.layer) : m.layer === key))
        if (!items.length) continue
        const isOpen = layersOpen[key] !== false
        const overdue = items.filter((m) => m.reviewBy && m.reviewBy < today).length
        rows.push(
          blank(),
          Button({
            key: 'layer-' + key,
            label: (isOpen ? '▾ ' : '▸ ') + T.count(label, items.length) + (overdue ? T.dueReviewN(overdue) : ''),
            plain: true,
            onPress: () => {
              layersOpen = { ...layersOpen, [key]: !isOpen }
              redraw()
            },
          }),
          longLine('  ' + hint, { dimColor: true }),
        )
        if (!isOpen) {
          rows.push(longLine('  ' + items.map((m) => m.name).join(' · '), { dimColor: true }))
          continue
        }
        if (key !== 'none') {
          for (const m of items) rows.push(...memItem(m))
          continue
        }
        for (const type of [...MEMORY_TYPES, 'other']) {
          const typed = items.filter((m) => (type === 'other' ? !MEMORY_TYPES.includes(m.type) : m.type === type))
          if (!typed.length) continue
          rows.push(line(['  ' + T.count(T.types[type], typed.length)], { dimColor: true }))
          for (const m of typed) rows.push(...memItem(m))
        }
      }
      return rows
    }

    // 分頁：任務
    const back = (trail) =>
      row([Button({ key: 'nav-back', label: T.back, onPress: () => goBack($) }), Text({ dimColor: true, wrap: 'truncate-end', children: [trail] })])

    const laneRow = (l) => {
      const { done, total, percent } = laneProgress(l)
      const [icon, color] = LANE_LOOK[laneDialog(l) ? 'blocked' : l.state]
      const standing = laneStanding(l, now)
      const urgent = l.state === 'blocked' || l.state === 'failed' || laneDialog(l)
      return [
        Box({
          flexDirection: 'row',
          children: [
            Text({ color, children: [icon + ' '] }),
            Box({
              flexGrow: 1,
              flexShrink: 1,
              children: [
                Button({
                  key: 'task-' + l.lane,
                  label: clipCells(l.lane + '  ' + l.title, Math.max(12, cols - 9)),
                  plain: true,
                  onPress: () => openPage($, { view: 'lane', lane: l.lane, back: 'task-' + l.lane }),
                }),
              ],
            }),
            Text({ color, children: [String(percent).padStart(4) + '%'] }),
          ],
        }),
        urgent
          ? longLine('  └ ' + standing, { color: 'red' })
          : longLine('  ' + bar(percent / 100, 8) + ' ' + done + '/' + total + (standing ? ' · ' + standing : ''), { dimColor: true }),
      ]
    }

    const taskList = () => {
      const rows = []
      if (lanesError) rows.push(longLine(lanesError, { color: 'red' }))
      if (!lanes.length) {
        rows.push(line([T.noLanes], { dimColor: true }), longLine(tasksDir, { dimColor: true }, 'truncate-middle'))
        return rows
      }
      const attention = lanes.filter(needsAttention)
      const active = lanes.filter((l) => l.state === 'working' && !attention.includes(l))
      const quiet = lanes.filter((l) => !attention.includes(l) && !active.includes(l))
      if (attention.length) {
        rows.push(line([T.needsYou(attention.length)], { bold: true }))
        for (const l of attention) rows.push(...laneRow(l))
        rows.push(blank())
      }
      if (active.length) {
        rows.push(line([T.working(active.length)], { bold: true }))
        for (const l of active) rows.push(...laneRow(l))
        rows.push(blank())
      }
      if (quiet.length) {
        const idle = quiet.filter((l) => l.state === 'idle').length
        rows.push(
          Button({
            key: 'toggle-quiet',
            label: (quietOpen ? '▾ ' : '▸ ') + T.quiet(idle, quiet.length - idle),
            plain: true,
            onPress: () => {
              quietOpen = !quietOpen
              redraw()
            },
          }),
        )
        if (quietOpen) for (const l of quiet) rows.push(...laneRow(l))
      }
      // 在 Herdr 裡、但沒有狀態檔的 agent（例如你自己開的 session）
      const tracked = new Set(lanes.map((l) => laneAgent(l)?.pane_id).filter(Boolean))
      const others = herdrAgents.filter((a) => a.workspace_id === herdrWorkspace && a.pane_id !== herdrSelf && !tracked.has(a.pane_id))
      if (others.length) {
        rows.push(blank(), line([T.otherAgents(others.length)], { dimColor: true }))
        for (const a of others) rows.push(longLine('  ' + (LANE_LOOK[a.agent_status === 'working' ? 'working' : a.agent_status === 'blocked' ? 'blocked' : 'idle'][0]) + ' ' + (a.name || a.pane_id) + ' · ' + (a.terminal_title_stripped || a.agent), { dimColor: true }))
      }
      return rows
    }

    const lanePage = (l) => {
      const { done, total, percent } = laneProgress(l)
      const [icon, color] = LANE_LOOK[l.state]
      const label = T.laneStates[l.state]
      const agent = laneAgent(l)
      const updated = Date.parse(l.updated)
      const rows = [
        back(T.tasks + ' › ' + l.lane),
        blank(),
        Box({
          flexDirection: 'row',
          children: [
            Box({ flexGrow: 1, flexShrink: 1, children: [line([l.title], { bold: true })] }),
            Text({ color, children: [' ' + percent + '% ' + done + '/' + total] }),
          ],
        }),
        longLine(
          icon + ' ' + label + (agent ? ' · Herdr ' + agent.agent_status : '') + (updated ? ' · ' + T.updated(ago(now - updated)) : '') + (l.head ? ' · HEAD ' + l.head : ''),
          { color },
        ),
      ]
      if (l.spec) rows.push(longLine(T.spec + l.spec, { dimColor: true }, 'truncate-middle'))
      rows.push(blank())
      for (const s of l.steps) {
        rows.push(
          longLine(STEP_ICONS[s.state] + ' ' + s.id + ' ' + s.title, {
            dimColor: s.state === 'done' || s.state === 'skip',
            color: s.state === 'doing' ? 'yellow' : undefined,
          }),
        )
      }
      if (l.state === 'blocked' && l.needs) rows.push(blank(), line([T.decide], { bold: true, color: 'red' }), line([l.needs]))
      if (l.notes?.length) {
        rows.push(blank(), line([T.notes], { bold: true }))
        for (const n of l.notes) rows.push(longLine('• ' + n, { dimColor: true }))
      }

      if (l.pane) {
        const screen = screens[l.lane]
        rows.push(
          blank(),
          row([
            Text({ bold: true, children: [T.liveScreen] }),
            Text({ dimColor: true, children: [screen?.at ? ago(now - screen.at) : T.loading] }),
            Button({
              key: 'screen-size',
              label: screenLong ? T.less : T.more,
              plain: true,
              onPress: () => {
                screenLong = !screenLong
                redraw()
              },
            }),
            Button({ key: 'screen-refresh', label: T.refresh, plain: true, onPress: () => refreshScreen($, l.lane) }),
          ]),
        )
        if (screen?.error) rows.push(longLine(screen.error, { color: 'red' }))
        const shown = (screen?.lines ?? []).slice(-(screenLong ? SCREEN_ROWS_LONG : SCREEN_ROWS))
        for (const text of shown) rows.push(Text({ wrap: 'truncate-end', children: [text || ' '] }))
        rows.push(
          row(
            [
              Text({ dimColor: true, children: [T.keys] }),
              ...LANE_KEYS.map(([key, keyLabel]) => Button({ key: 'lane-key-' + key, label: keyLabel, onPress: () => keyToLane($, l.lane, key) })),
            ],
            1,
          ),
          Input({
            key: 'lane-reply',
            placeholder: laneDialog(l) ? T.dialogPlaceholder : T.replyPlaceholder(l.lane),
            submitLabel: T.send,
            onSubmit: (text) => sendToLane($, l.lane, text),
          }),
        )
      }

      const extra = []
      if (l.report) extra.push(Button({ key: 'lane-report', label: '▸ ' + T.report + ' ' + l.report.split(/[\\/]/).pop(), plain: true, onPress: () => openPage($, { view: 'report', lane: l.lane, back: 'lane-report' }) }))
      const laneMemories = memories.filter((m) => m.lane === l.lane)
      if (laneMemories.length) {
        extra.push(line([T.laneMemories(laneMemories.length)], { bold: true }))
        for (const m of laneMemories) extra.push(...memItem(m, 'lane-'))
      }
      if (extra.length) rows.push(blank(), ...extra)
      return rows
    }

    const reportPage = (l) => {
      const report = reports[l.lane]
      const rows = [back(T.tasks + ' › ' + l.lane + ' › ' + T.report), blank()]
      if (!report) return [...rows, line([T.loading], { dimColor: true })]
      rows.push(longLine(report.path, { dimColor: true }, 'truncate-middle'))
      if (report.error) return [...rows, line([report.error], { color: 'red' })]
      return [...rows, Markdown({ key: 'report-' + l.lane, text: report.text.slice(0, 12000) })]
    }

    const tasksBody = () => {
      const page = route[route.length - 1]
      const l = page && lanes.find((x) => x.lane === page.lane)
      if (!page) return taskList()
      if (!l) return [back(T.tasks), line([T.laneGone], { dimColor: true })]
      return page.view === 'report' ? reportPage(l) : lanePage(l)
    }

    // 分頁 3：Herdr
    const HERDR_ICONS = {
      working: ['◐', 'yellow'],
      blocked: ['⚠', 'red'],
      done: ['✔', 'green'],
      idle: ['○', undefined],
      unknown: ['?', undefined],
    }
    const agentRow = (key, a, extra) => {
      const [icon, color] = a ? HERDR_ICONS[a.agent_status] ?? ['?', undefined] : ['✕', undefined]
      const head = a
        ? icon + ' ' + (a.name ? a.name + '（' + a.agent + '）' : a.agent) + ' ' + a.pane_id + ' · ' + a.agent_status
        : icon + ' ' + key + ' · ' + T.notAgent
      const rows = [line([head], { color, dimColor: !a, bold: a?.agent_status === 'blocked', wrap: 'truncate-end' })]
      if (a?.terminal_title_stripped) rows.push(longLine('  ' + a.terminal_title_stripped, { dimColor: true }))
      if (extra) rows.push(longLine('  ' + extra, { dimColor: true }))
      return rows
    }
    const herdrBody = () => {
      const rows = [
        row([
          Text({ dimColor: true, children: [T.thisPane(herdrSelf)] }),
          Button({ key: 'reload-herdr', label: T.refresh, onPress: () => refreshHerdr($) }),
        ]),
      ]
      if (herdrError) rows.push(longLine(herdrError, { color: 'red' }))

      const byPane = (t) => herdrAgents.find((a) => a.pane_id === t || (a.name && a.name === t))
      const targets = Object.values(herdrTargets).sort((a, b) => b.at - a.at)
      // 同一個 agent 可能用名稱和 pane id 各指揮過，合併成一列
      const seen = new Set()
      const commanded = []
      for (const t of targets) {
        const a = byPane(t.target)
        const id = a ? a.pane_id : t.target
        if (seen.has(id)) continue
        seen.add(id)
        commanded.push({ t, a })
      }

      rows.push(blank(), line([T.commanded(commanded.length)], { bold: true }))
      if (!commanded.length) rows.push(line([T.noCommanded], { dimColor: true }))
      for (const { t, a } of commanded) {
        const action = T.herdrActions[t.action] ?? t.action
        rows.push(...agentRow(t.target, a, T.lastAction(action, t.detail, ago(now - t.at))))
      }

      const others = herdrAgents.filter((a) => a.workspace_id === herdrWorkspace && a.pane_id !== herdrSelf && !seen.has(a.pane_id))
      if (others.length) {
        rows.push(blank(), line([T.sameWorkspace(others.length)], { bold: true }))
        for (const a of others) rows.push(...agentRow(a.pane_id, a))
      }
      return rows
    }

    // 底部：快取倒數與自動交接
    const footer = () => {
      const width = Math.max(8, Math.min(20, cols - 30))
      let cacheLine
      let color
      if (!lastRequestAt) {
        cacheLine = T.cache + ' ' + '░'.repeat(width) + ' ' + T.cacheNotYet
        color = undefined
      } else {
        const remaining = lastRequestAt + ttlMs() - now
        if (remaining <= 0) {
          cacheLine = T.cache + ' ' + '░'.repeat(width) + ' ' + T.cacheExpired(duration(-remaining))
          color = 'red'
        } else {
          cacheLine = T.cache + ' ' + bar(remaining / ttlMs(), width) + ' ' + duration(remaining)
          color = remaining <= LEAD_MS ? 'red' : remaining <= 2 * LEAD_MS ? 'yellow' : 'green'
        }
      }
      const phaseLabel =
        phase === 'handoff'
          ? T.handingOff
          : phase === 'compacting'
            ? T.compacting
            : !auto
              ? ''
              : cacheTtl !== '1h'
                ? T.ttlNoAuto(cacheTtl)
                : armed
                  ? T.standby
                  : T.doneWaiting

      return [
        rule(),
        ...(model ? [line([T.model(model)], { dimColor: true, wrap: 'truncate-end' })] : []),
        line([cacheLine], { color, wrap: 'truncate-end' }),
        row([
          toggle('toggle-auto', T.autoHandoff, auto, async () => {
            auto = !auto
            redraw()
            await $.store.set('auto', auto)
          }),
          ...(phaseLabel ? [Text({ dimColor: true, children: [phaseLabel] })] : []),
          Button({
            key: 'handoff-now',
            label: T.handoffNow,
            dimColor: phase !== 'idle',
            onPress: () => handoffNow($),
          }),
        ]),
        ...(note ? [longLine(note, { dimColor: true })] : []),
      ]
    }

    return Box({
      flexDirection: 'column',
      children: [
        row(
          [
            ...(tasksDir ? [tabButton('tasks', T.tasks + (lanes.filter(needsAttention).length ? ' ⚠' + lanes.filter(needsAttention).length : ''))] : []),
            tabButton('memory', T.tabMemory(memories.length)),
            tabButton('progress', tasksDir ? T.tabHandoff : T.tabProgress),
            // 有任務分頁時 Herdr 退到後台：lane 的畫面與操作都在任務的子頁裡
            ...(herdrEnv && !tasksDir ? [tabButton('herdr', 'Herdr')] : []),
            toggle('toggle-wrap', T.wrap, wrapLong, async () => {
              wrapLong = !wrapLong
              redraw()
              await $.store.set('wrap', wrapLong)
            }),
          ],
          3,
        ),
        blank(),
        ...(tab === 'tasks' && tasksDir
          ? tasksBody()
          : tab === 'herdr' && herdrEnv && !tasksDir
            ? herdrBody()
            : tab === 'memory'
              ? memoryBody()
              : progressBody()),
        blank(),
        ...footer(),
      ],
    })
  })
}
