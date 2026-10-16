// baton：側邊工作看板（原名 session-board）
// 分頁「任務」（專案設了 tasks_dir 時）：每條 lane 一到兩行＋百分比，點開是 lane 的子頁（步驟、即時畫面、回覆、報告、記憶），可返回原位
// 分頁「進度／交接」：執行狀態、任務清單、上下文用量、交接文件
// 分頁「記憶」：本專案的記憶檔，依 layer 分層（使用者／專案／工作線／階段）
// 底部：提示快取倒數；快取快過期時自動寫交接（狀態檔或交接文件），寫完後觸發壓縮

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
const HANDOFF_PREFIX = '[自動交接]'

// lane 狀態檔（tasks_dir 底下每條 lane 一個 <lane>.json）；順序＝顯示順序，要人處理的在前
const LANE_ORDER = ['blocked', 'failed', 'review', 'working', 'idle', 'done']
const LANE_LOOK = {
  blocked: ['⚠', 'red', '等你'],
  failed: ['✖', 'red', '失敗'],
  review: ['✔', 'yellow', '待審'],
  working: ['◐', 'green', '進行中'],
  idle: ['○', undefined, '待命'],
  done: ['✓', undefined, '完成'],
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

// 記憶分層（frontmatter 的 metadata.layer）；沒標的歸「未分層」
const LAYERS = [
  ['user', '使用者', '你的偏好與做法，每次都帶'],
  ['project', '專案', '長期不變的事實與決定'],
  ['workstream', '工作線', '跟著某條 lane'],
  ['phase', '階段', '目前這一段，會過期'],
]


const TYPE_LABELS = [
  ['feedback', '叮囑'],
  ['user', '關於你'],
  ['project', '專案'],
  ['reference', '參考'],
]

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
    note = '讀取專案設定失敗：' + String(err)
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
  if (laneDialog(l) && l.state !== 'blocked') return '對話框等確認'
  if (l.state === 'blocked') return '等你：' + (l.needs ?? '')
  if (l.state === 'failed') return '失敗' + (l.needs ? '：' + l.needs : step ? '於 ' + step.id + ' ' + step.title : '')
  if (l.state === 'review') return '做完待審' + (l.head ? ' · HEAD ' + l.head : '')
  if (l.state === 'working') {
    if (l.lane === selfLane && working) return '● 執行中 ' + duration(now - turnStartedAt) + (step ? ' · ' + step.id + ' ' + step.title : '')
    const stale = now - Date.parse(l.updated) > STALE_MS ? ' · ' + ago(now - Date.parse(l.updated)) + '沒更新' : ''
    return (step ? step.id + ' ' + step.title : '') + stale
  }
  if (l.state === 'idle') return l.needs || '待命'
  return '已驗收'
}

async function loadLanes($) {
  if (!tasksDir) {
    lanes = []
    return
  }
  try {
    if (!(await $.fs.exists(tasksDir))) {
      lanes = []
      lanesError = '找不到任務資料夾'
      return
    }
    const entries = await $.fs.list(tasksDir)
    const list = []
    const bad = []
    for (const f of entries.filter((x) => x.kind === 'file' && x.name.endsWith('.json'))) {
      try {
        const v = JSON.parse(await $.fs.read(tasksDir + '/' + f.name))
        if (!v || typeof v.lane !== 'string' || typeof v.title !== 'string' || !LANE_ORDER.includes(v.state) || !Array.isArray(v.steps)) throw new Error('格式不符')
        list.push(v)
      } catch {
        bad.push(f.name)
      }
    }
    lanes = list.sort((a, b) => LANE_ORDER.indexOf(a.state) - LANE_ORDER.indexOf(b.state) || a.lane.localeCompare(b.lane))
    lanesError = bad.length ? '讀不懂：' + bad.join('、') : ''
  } catch (err) {
    lanesError = '讀取任務失敗：' + String(err)
  }
  // 別的 lane 變成等你、待審、失敗時提醒（第一次載入不提醒）
  for (const l of lanes) {
    const prev = laneStates[l.lane]
    laneStates[l.lane] = l.state
    if (!prev || prev === l.state || l.lane === selfLane) continue
    if (l.state === 'blocked') $.ui.toast(clip(l.lane + ' 等你：' + (l.needs ?? ''), 80))
    if (l.state === 'review') $.ui.toast(l.lane + ' 做完了，等驗收')
    if (l.state === 'failed') $.ui.toast(l.lane + ' 失敗')
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
    screens = { ...screens, [lane]: { lines: [], at, error: '讀不到畫面：' + clip(String(err), 80) } }
  }
  $.ui.invalidate('ui.render')
}

async function sendToLane($, lane, text) {
  const l = lanes.find((x) => x.lane === lane)
  if (!l?.pane || !String(text).trim()) return
  const r = await $.process.run([herdrBin, 'agent', 'prompt', l.pane, text], { timeoutMs: 10000 })
  if (r.exitCode !== 0) {
    $.ui.toast('沒送出：' + clip(r.stderr || r.stdout || 'exit ' + r.exitCode, 60))
    return
  }
  $.ui.toast('已送給 ' + lane)
  herdrCommandAt = await $.clock.now()
  $.clock.after(1500, () => refreshScreen($, lane))
}

async function keyToLane($, lane, key) {
  const l = lanes.find((x) => x.lane === lane)
  if (!l?.pane) return
  const r = await $.process.run([herdrBin, 'agent', 'send-keys', l.pane, key], { timeoutMs: 5000 })
  if (r.exitCode !== 0) $.ui.toast('按鍵沒送出：' + clip(r.stderr || 'exit ' + r.exitCode, 60))
  herdrCommandAt = await $.clock.now()
  $.clock.after(800, () => refreshScreen($, lane))
}

async function loadReport($, lane) {
  const l = lanes.find((x) => x.lane === lane)
  if (!l?.report) return
  try {
    const path = await expandPath($, l.report)
    if (!(await $.fs.exists(path))) {
      reports = { ...reports, [lane]: { text: '', path, error: '報告檔不存在' } }
    } else {
      reports = { ...reports, [lane]: { text: await $.fs.read(path), path, error: '' } }
    }
  } catch (err) {
    reports = { ...reports, [lane]: { text: '', path: l.report, error: '讀不到報告：' + String(err) } }
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
    note = '寫入壓縮摘要失敗：' + String(err)
  }
  $.ui.invalidate('ui.render')
}

function ago(ms) {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return '剛剛'
  if (s < 3600) return Math.floor(s / 60) + ' 分鐘前'
  return Math.floor(s / 3600) + ' 小時前'
}

const HERDR_AGENT_TARGETED = ['prompt', 'send-keys', 'read', 'wait', 'focus', 'get', 'rename', 'attach', 'explain']
const HERDR_ACTION_LABELS = {
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
}

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
    herdrError = '讀取 herdr 失敗：' + String(err)
    return
  }
  // 指揮過的 agent 進入 blocked／done 時提醒
  for (const a of herdrAgents) {
    const prev = herdrStatus[a.pane_id]
    herdrStatus[a.pane_id] = a.agent_status
    if (!prev || prev === a.agent_status || !isCommanded(a)) continue
    const who = a.name || a.agent + ' ' + a.pane_id
    if (a.agent_status === 'blocked') $.ui.toast(who + ' 在等待確認')
    if (a.agent_status === 'done') $.ui.toast(who + ' 已完成')
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
function laneBriefing(now) {
  const lines = [
    '[baton] 這個專案用 lane 狀態檔交接：',
    '- 任務狀態：' + tasksDir + '/<lane>.json，一條 lane 一個；你自己的是 ' + selfLane + '.json。格式與更新規則見該資料夾的 README。',
    '- 詳細交接：' + handoffFile + (handoffSection ? ' 的「' + handoffSection + '」一節' : '') + '，需要細節時再讀。',
    '- 記憶：' + memoryDir + '（frontmatter 的 metadata.layer 分成 user／project／workstream／phase）',
    '- 主控 session 的提示快取快過期時，會要求你更新自己的狀態檔，接著自動壓縮對話。',
    '',
    '任務一覽（若和使用者這次的要求無關，可以忽略）：',
  ]
  if (lanesError) lines.push('（' + lanesError + '）')
  for (const l of lanes) {
    const { done, total, percent } = laneProgress(l)
    lines.push(LANE_LOOK[l.state][0] + ' ' + l.lane + '：' + l.title + ' ' + percent + '%（' + done + '/' + total + '）· ' + laneStanding(l, now))
  }
  const self = lanes.find((l) => l.lane === selfLane)
  if (self) {
    lines.push('', '你自己的步驟（' + selfLane + '）：')
    for (const s of self.steps) lines.push(STEP_ICONS[s.state] + ' ' + s.id + ' ' + s.title)
    if (self.needs) lines.push('等使用者決定：' + self.needs)
    for (const n of self.notes ?? []) lines.push('• ' + n)
  }
  return lines.join('\n')
}

// 附在 prompt 後面給 Claude 看的說明（使用者看不到）
function briefing(now) {
  if (tasksDir) return laneBriefing(now)
  const lines = [
    '[baton] 這個專案使用 baton 交接機制：',
    '- 交接文件：' +
      handoffFile +
      (handoffSection ? ' 的「' + handoffSection + '」一節（專案自己的文件，只更新這一節）' : '') +
      (handoff.mtimeMs ? '（最後更新 ' + clock(handoff.mtimeMs) + '）' : '（尚未建立）'),
    '- 壓縮摘要：' + compactFile,
    '- 記憶資料夾：' + memoryDir,
    '- 主控 session 的提示快取快過期時，會要求你更新交接文件，接著自動壓縮對話。',
    '- 這個專案還沒開「任務」分頁。如果工作有多條並行的線（派工給 herdr、有待派工清單、交接裡同時好幾項進行中），找適當時機問使用者要不要建立；不要自己建。',
    '  建法：在 ' +
      projectSettingsFile +
      ' 寫 {"tasks_dir": "<資料夾>"}，資料夾裡每條 lane 一個 <lane>.json：lane、title（一行）、state（blocked／failed／review／working／idle／done）、steps（{ id, title, state: todo|doing|done|skip }）、updated，選填 needs、pane、spec、head、report、notes；主控自己那條叫 ' +
      selfLane +
      '.json。',
  ]
  if (handoff.text) {
    lines.push('', '以下是目前的交接文件，請據此接續先前的工作；若和使用者這次的要求無關，可以忽略。', '', '<handoff>', handoff.text.slice(0, 20000), '</handoff>')
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
    note = '讀取記憶失敗：' + String(err)
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
  const head = HANDOFF_PREFIX + ' 提示快取約 ' + Math.max(1, Math.round(remainingMs / 60000)) + ' 分鐘後過期，接下來會自動壓縮對話。請立刻：'
  if (tasksDir) {
    return [
      head,
      '1. 覆寫你自己的狀態檔 `' + tasksDir + '/' + selfLane + '.json`：steps 的狀態照實更新；要使用者決定的事寫 needs；接手需要知道、但不屬於任何步驟的事寫 notes（最多 8 則，一行一則）。依該資料夾 README 的規則驗證，並更新它說要產生的總覽。',
      '2. 你驗收過或確認過狀態改變的 lane，也更新它們的狀態檔。',
      '3. 若有值得長期保存的使用者叮囑或專案事實，順手更新記憶（`' + memoryDir + '`，標上 metadata.layer）。',
      '4. 不要開始新的工作。寫完用一兩句回報即可。',
    ].join('\n')
  }
  const write = handoffSection
    ? '1. 更新 `' + handoffFile + '` 中目前的「' + handoffSection + '」那一節（這是專案自己的文件：依它既有的格式與慣例更新，不要整份覆寫、不要動其他章節）：'
    : '1. 把目前的處理進度寫進 `' + handoffFile + '`（整份覆寫、精簡）：'
  return [
    head,
    write + '目標、已完成、進行中、下一步、關鍵檔案與決策、待使用者確認的問題。',
    '2. 若有值得長期保存的使用者叮囑或專案事實，順手更新記憶（`' + memoryDir + '`）。',
    '3. 不要開始新的工作。寫完用一兩句回報即可。',
  ].join('\n')
}

function compactInstructions() {
  if (tasksDir) return '保留 ' + tasksDir + ' 的 lane 狀態檔所指的進度、等待使用者決定的事與下一步；壓縮後以狀態檔為準繼續工作。'
  const where = handoffSection ? handoffFile + ' 的「' + handoffSection + '」一節' : handoffFile
  return '保留 ' + where + ' 的重點、目前任務狀態與下一步；壓縮後以交接文件為準繼續工作。'
}

async function startHandoff($, remainingMs) {
  phase = 'handoff'
  handoffTurnId = ''
  handoffSentAt = await $.clock.now()
  note = '已送出交接指示'
  $.ui.toast('快取即將過期，開始寫交接文件')
  $.ui.invalidate('ui.render')
  // 不 await：submit 會等到 session 閒置才開始新的一輪；被擋或失敗時退回 idle，免得一直卡在「交接中…」
  void $.prompt.submit({ text: handoffPrompt(remainingMs) }).then(
    (r) => {
      if (r?.drop !== undefined) failHandoff($, '交接指示被擋下：' + r.drop)
    },
    (err) => failHandoff($, '交接指示送出失敗：' + String(err)),
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
    $.ui.toast(phase === 'handoff' ? '已經在交接中' : '正在壓縮中')
    return
  }
  const remaining = lastRequestAt ? lastRequestAt + ttlMs() - (await $.clock.now()) : LEAD_MS
  await startHandoff($, Math.max(remaining, 60000))
}

async function runCompact($) {
  try {
    const r = await $.session.compact({ instructions: compactInstructions() })
    note = r.skip ? '壓縮被略過：' + r.skip : '交接完成並已壓縮'
    phase = 'idle'
    armed = false
  } catch (err) {
    // 一輪還在跑時 compact 會被拒絕，稍後重試
    compactTries += 1
    if (compactTries < 6) {
      $.clock.after(3000, () => runCompact($))
      return
    }
    note = '壓縮失敗：' + String(err)
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
    note = '上下文只有 ' + Math.round(percent) + '%，略過自動交接'
    $.ui.invalidate('ui.render')
    return
  }
  await startHandoff($, remaining)
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
  await $.ui.open({ id: PANE, title: '工作看板', focus: true, columns: 50 })
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

  // 切換模型時引擎會告知目前的快取 TTL，以它為準
  on('classic.PostModelSwitch', async ($, e, next) => {
    if (e.cache_ttl in CACHE_TTLS) cacheTtl = e.cache_ttl
    $.ui.invalidate('ui.render')
    return next(e)
  })

  on('session.start', async ($, e, next) => {
    sessionId = await $.session.id()
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
      await $.command.register({ name: 'board', description: '開關工作看板（進度／記憶／快取倒數）', immediate: true })
    } catch (err) {
      note = '註冊 /board 失敗：' + String(err)
    }
    // 非全螢幕時滑鼠點不到看板按鈕，用指令觸發立即交接
    try {
      await $.command.register({ name: 'handoff', description: '立即交接：寫交接文件後壓縮對話（等同看板的「立即交接」）', immediate: true })
    } catch (err) {
      note = '註冊 /handoff 失敗：' + String(err)
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

  // 輸入框上方的一顆按鈕：看板關著時才出現，點了打開（狀態列是外部指令輸出的文字，放不了按鈕）
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!launcherButton || paneOpen || e.props.hasSurvey) return next(e)
    const { Box, Button } = $.ui.resolve(e)
    return Box({
      flexDirection: 'row',
      justifyContent: 'flex-end',
      children: [Button({ key: 'open-board', label: '◧ 工作看板', plain: true, dimColor: true, onPress: () => toggleBoard($) })],
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
      if (briefOnStart && needsBriefing) {
        needsBriefing = false
        await loadHandoff($)
        await loadLanes($)
        return next({ ...e, context: [...(e.context ?? []), briefing(await $.clock.now())] })
      }
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
      if (phase === 'handoff' && !handoffTurnId && String(e.text ?? '').includes(HANDOFF_PREFIX)) handoffTurnId = e.turnId
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
    }
    return result
  })

  on('turn.complete', async ($, e, next) => {
    if (!e.agentId) {
      working = false
      currentTool = ''
      if (e.answer) lastAnswer = e.answer
      await refreshUsage($)
      if (phase === 'handoff' && handoffTurnId && e.turnId === handoffTurnId) {
        await loadHandoff($)
        if (e.isAborted) {
          phase = 'idle'
          armed = false
          note = '交接那一輪被中斷，本次不壓縮'
        } else {
          phase = 'compacting'
          compactTries = 0
          note = '交接文件已寫好，準備壓縮'
          // 等這一輪完全結束再壓縮
          $.clock.after(1500, () => runCompact($))
        }
      }
      $.ui.invalidate('ui.render')
    }
    return next(e)
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
    const result = await next(e)
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
        rows.push(line(['● 執行中 ' + duration(now - turnStartedAt) + ' · 本輪工具 ' + toolCalls + ' 次'], { color: 'green' }))
        if (currentTool) rows.push(longLine('  ' + currentTool, { dimColor: true }))
      } else {
        rows.push(line(['○ 閒置'], { dimColor: true }))
      }

      const stats = []
      const percent = usage?.context?.percent
      if (typeof percent === 'number') stats.push('上下文 ' + Math.round(percent) + '%')
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
        rows.push(blank(), line(['任務 ' + done + '/' + taskList.length + '  ' + bar(done / taskList.length, 12)], { bold: true }))
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
        rows.push(blank(), line(['上一輪回覆'], { bold: true }), longLine(clip(lastAnswer, cols * 3), { dimColor: true }))
      }

      if (compactInfo.summary) {
        const k = (n) => (n >= 1000 ? Math.round(n / 1000) + 'k' : String(n))
        const tokens = compactInfo.tokensBefore ? ' · ' + k(compactInfo.tokensBefore) + ' → ' + k(compactInfo.tokensAfter) + ' tokens' : ''
        rows.push(
          blank(),
          Button({
            key: 'toggle-compact',
            label: (compactOpen ? '▾ ' : '▸ ') + '壓縮後保留（' + clock(compactInfo.at) + tokens + '）',
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
          line(['交接文件（' + clock(handoff.mtimeMs) + '）' + (handoffSection ? ' · 只讀「' + handoffSection + '」一節' : '')], { bold: true }),
          longLine(handoffFile, { dimColor: true }, 'truncate-middle'),
          Markdown({ key: 'handoff', text: handoff.text.slice(0, 6000) }),
        )
      } else {
        rows.push(line(['尚無交接文件'], { dimColor: true }), longLine(handoffFile, { dimColor: true }, 'truncate-middle'))
      }
      return rows
    }

    // 一則記憶：標題可展開全文
    const today = new Date(now).toISOString().slice(0, 10)
    const memItem = (m, prefix = '') => {
      const isOpen = expanded === m.file
      const overdue = m.reviewBy && m.reviewBy < today
      const tags = [m.lane ? '〔' + m.lane + '〕' : '', overdue ? ' ⚠ 該檢查了' : ''].join('')
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
          Text({ dimColor: true, children: [memories.length + ' 則記憶'] }),
          Button({
            key: 'reload-memory',
            label: '重新整理',
            onPress: () => loadMemories($),
          }),
        ]),
      ]
      rows.push(longLine(memoryDir, { dimColor: true }, 'truncate-middle'))
      if (!memories.length) {
        rows.push(line(['這個資料夾還沒有記憶。'], { dimColor: true }))
        return rows
      }
      const known = LAYERS.map(([key]) => key)
      for (const [key, label, hint] of [...LAYERS, ['none', '未分層', '還沒標 layer']]) {
        const items = memories.filter((m) => (key === 'none' ? !known.includes(m.layer) : m.layer === key))
        if (!items.length) continue
        const isOpen = layersOpen[key] !== false
        const overdue = items.filter((m) => m.reviewBy && m.reviewBy < today).length
        rows.push(
          blank(),
          Button({
            key: 'layer-' + key,
            label: (isOpen ? '▾ ' : '▸ ') + label + '（' + items.length + '）' + (overdue ? ' ⚠ ' + overdue + ' 則該檢查了' : ''),
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
        const types = TYPE_LABELS.map(([type]) => type)
        for (const [type, typeLabel] of [...TYPE_LABELS, ['other', '其他']]) {
          const typed = items.filter((m) => (type === 'other' ? !types.includes(m.type) : m.type === type))
          if (!typed.length) continue
          rows.push(line(['  ' + typeLabel + '（' + typed.length + '）'], { dimColor: true }))
          for (const m of typed) rows.push(...memItem(m))
        }
      }
      return rows
    }

    // 分頁：任務
    const back = (trail) =>
      row([Button({ key: 'nav-back', label: '← 返回', onPress: () => goBack($) }), Text({ dimColor: true, wrap: 'truncate-end', children: [trail] })])

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
        rows.push(line(['還沒有 lane 狀態檔。'], { dimColor: true }), longLine(tasksDir, { dimColor: true }, 'truncate-middle'))
        return rows
      }
      const attention = lanes.filter(needsAttention)
      const active = lanes.filter((l) => l.state === 'working' && !attention.includes(l))
      const quiet = lanes.filter((l) => !attention.includes(l) && !active.includes(l))
      if (attention.length) {
        rows.push(line(['需要處理 ' + attention.length], { bold: true }))
        for (const l of attention) rows.push(...laneRow(l))
        rows.push(blank())
      }
      if (active.length) {
        rows.push(line(['進行中 ' + active.length], { bold: true }))
        for (const l of active) rows.push(...laneRow(l))
        rows.push(blank())
      }
      if (quiet.length) {
        const idle = quiet.filter((l) => l.state === 'idle').length
        rows.push(
          Button({
            key: 'toggle-quiet',
            label: (quietOpen ? '▾ ' : '▸ ') + '待命 ' + idle + ' · 已完成 ' + (quiet.length - idle),
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
        rows.push(blank(), line(['其他 agent（沒有狀態檔）' + others.length], { dimColor: true }))
        for (const a of others) rows.push(longLine('  ' + (LANE_LOOK[a.agent_status === 'working' ? 'working' : a.agent_status === 'blocked' ? 'blocked' : 'idle'][0]) + ' ' + (a.name || a.pane_id) + ' · ' + (a.terminal_title_stripped || a.agent), { dimColor: true }))
      }
      return rows
    }

    const lanePage = (l) => {
      const { done, total, percent } = laneProgress(l)
      const [icon, color, label] = LANE_LOOK[l.state]
      const agent = laneAgent(l)
      const updated = Date.parse(l.updated)
      const rows = [
        back('任務 › ' + l.lane),
        blank(),
        Box({
          flexDirection: 'row',
          children: [
            Box({ flexGrow: 1, flexShrink: 1, children: [line([l.title], { bold: true })] }),
            Text({ color, children: [' ' + percent + '% ' + done + '/' + total] }),
          ],
        }),
        longLine(
          icon + ' ' + label + (agent ? ' · Herdr ' + agent.agent_status : '') + (updated ? ' · 更新 ' + ago(now - updated) : '') + (l.head ? ' · HEAD ' + l.head : ''),
          { color },
        ),
      ]
      if (l.spec) rows.push(longLine('規格 ' + l.spec, { dimColor: true }, 'truncate-middle'))
      rows.push(blank())
      for (const s of l.steps) {
        rows.push(
          longLine(STEP_ICONS[s.state] + ' ' + s.id + ' ' + s.title, {
            dimColor: s.state === 'done' || s.state === 'skip',
            color: s.state === 'doing' ? 'yellow' : undefined,
          }),
        )
      }
      if (l.state === 'blocked' && l.needs) rows.push(blank(), line(['等你決定'], { bold: true, color: 'red' }), line([l.needs]))
      if (l.notes?.length) {
        rows.push(blank(), line(['備註'], { bold: true }))
        for (const n of l.notes) rows.push(longLine('• ' + n, { dimColor: true }))
      }

      if (l.pane) {
        const screen = screens[l.lane]
        rows.push(
          blank(),
          row([
            Text({ bold: true, children: ['即時畫面'] }),
            Text({ dimColor: true, children: [screen?.at ? ago(now - screen.at) : '讀取中…'] }),
            Button({
              key: 'screen-size',
              label: screenLong ? '少一點' : '多一點',
              plain: true,
              onPress: () => {
                screenLong = !screenLong
                redraw()
              },
            }),
            Button({ key: 'screen-refresh', label: '重新整理', plain: true, onPress: () => refreshScreen($, l.lane) }),
          ]),
        )
        if (screen?.error) rows.push(longLine(screen.error, { color: 'red' }))
        const shown = (screen?.lines ?? []).slice(-(screenLong ? SCREEN_ROWS_LONG : SCREEN_ROWS))
        for (const text of shown) rows.push(Text({ wrap: 'truncate-end', children: [text || ' '] }))
        rows.push(
          row(
            [
              Text({ dimColor: true, children: ['按鍵'] }),
              ...LANE_KEYS.map(([key, keyLabel]) => Button({ key: 'lane-key-' + key, label: keyLabel, onPress: () => keyToLane($, l.lane, key) })),
            ],
            1,
          ),
          Input({
            key: 'lane-reply',
            placeholder: laneDialog(l) ? '對話框在等確認，先用上面的按鍵' : '回覆 ' + l.lane + '…',
            submitLabel: '送出',
            onSubmit: (text) => sendToLane($, l.lane, text),
          }),
        )
      }

      const extra = []
      if (l.report) extra.push(Button({ key: 'lane-report', label: '▸ 報告 ' + l.report.split(/[\\/]/).pop(), plain: true, onPress: () => openPage($, { view: 'report', lane: l.lane, back: 'lane-report' }) }))
      const laneMemories = memories.filter((m) => m.lane === l.lane)
      if (laneMemories.length) {
        extra.push(line(['這條線的記憶（' + laneMemories.length + '）'], { bold: true }))
        for (const m of laneMemories) extra.push(...memItem(m, 'lane-'))
      }
      if (extra.length) rows.push(blank(), ...extra)
      return rows
    }

    const reportPage = (l) => {
      const report = reports[l.lane]
      const rows = [back('任務 › ' + l.lane + ' › 報告'), blank()]
      if (!report) return [...rows, line(['讀取中…'], { dimColor: true })]
      rows.push(longLine(report.path, { dimColor: true }, 'truncate-middle'))
      if (report.error) return [...rows, line([report.error], { color: 'red' })]
      return [...rows, Markdown({ key: 'report-' + l.lane, text: report.text.slice(0, 12000) })]
    }

    const tasksBody = () => {
      const page = route[route.length - 1]
      const l = page && lanes.find((x) => x.lane === page.lane)
      if (!page) return taskList()
      if (!l) return [back('任務'), line(['這條 lane 的狀態檔不見了。'], { dimColor: true })]
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
        : icon + ' ' + key + ' · 已結束或不是 agent pane'
      const rows = [line([head], { color, dimColor: !a, bold: a?.agent_status === 'blocked', wrap: 'truncate-end' })]
      if (a?.terminal_title_stripped) rows.push(longLine('  ' + a.terminal_title_stripped, { dimColor: true }))
      if (extra) rows.push(longLine('  ' + extra, { dimColor: true }))
      return rows
    }
    const herdrBody = () => {
      const rows = [
        row([
          Text({ dimColor: true, children: ['本 pane ' + herdrSelf] }),
          Button({ key: 'reload-herdr', label: '重新整理', onPress: () => refreshHerdr($) }),
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

      rows.push(blank(), line(['這個 session 指揮的（' + commanded.length + '）'], { bold: true }))
      if (!commanded.length) rows.push(line(['還沒有透過 herdr 指揮其他 pane。'], { dimColor: true }))
      for (const { t, a } of commanded) {
        const action = HERDR_ACTION_LABELS[t.action] ?? t.action
        rows.push(...agentRow(t.target, a, '最後：' + action + (t.detail ? '「' + t.detail + '」' : '') + ' · ' + ago(now - t.at)))
      }

      const others = herdrAgents.filter((a) => a.workspace_id === herdrWorkspace && a.pane_id !== herdrSelf && !seen.has(a.pane_id))
      if (others.length) {
        rows.push(blank(), line(['同工作區的其他 agent（' + others.length + '）'], { bold: true }))
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
        cacheLine = '快取 ' + '░'.repeat(width) + ' 尚未建立'
        color = undefined
      } else {
        const remaining = lastRequestAt + ttlMs() - now
        if (remaining <= 0) {
          cacheLine = '快取 ' + '░'.repeat(width) + ' 已過期 ' + duration(-remaining) + ' 前'
          color = 'red'
        } else {
          cacheLine = '快取 ' + bar(remaining / ttlMs(), width) + ' ' + duration(remaining)
          color = remaining <= LEAD_MS ? 'red' : remaining <= 2 * LEAD_MS ? 'yellow' : 'green'
        }
      }
      const phaseLabel =
        phase === 'handoff'
          ? '交接中…'
          : phase === 'compacting'
            ? '壓縮中…'
            : !auto
              ? ''
              : cacheTtl !== '1h'
                ? '快取 ' + cacheTtl + '，不自動交接'
                : armed
                  ? '待命'
                  : '已完成，等新指示'

      return [
        rule(),
        ...(model ? [line(['模型 ' + model], { dimColor: true, wrap: 'truncate-end' })] : []),
        line([cacheLine], { color, wrap: 'truncate-end' }),
        row([
          toggle('toggle-auto', '自動交接', auto, async () => {
            auto = !auto
            redraw()
            await $.store.set('auto', auto)
          }),
          ...(phaseLabel ? [Text({ dimColor: true, children: [phaseLabel] })] : []),
          Button({
            key: 'handoff-now',
            label: '立即交接',
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
            ...(tasksDir ? [tabButton('tasks', '任務' + (lanes.filter(needsAttention).length ? ' ⚠' + lanes.filter(needsAttention).length : ''))] : []),
            tabButton('memory', '記憶 (' + memories.length + ')'),
            tabButton('progress', tasksDir ? '交接' : '進度'),
            // 有任務分頁時 Herdr 退到後台：lane 的畫面與操作都在任務的子頁裡
            ...(herdrEnv && !tasksDir ? [tabButton('herdr', 'Herdr')] : []),
            toggle('toggle-wrap', '換行', wrapLong, async () => {
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
