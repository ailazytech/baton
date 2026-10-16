import { expect, mock, test } from 'claude-code/testing'

// 測試裡的使用者、專案、路徑與 lane 都是虛構的（去識別化）
//
// macOS 與 Windows 的差異（外掛內部一律轉成 / 分隔）：
// - 家目錄：macOS 讀 HOME（/Users/<名稱>），Windows 讀 USERPROFILE（C:\Users\<名稱>）
// - 專案根目錄：macOS 從 / 開始；Windows 有磁碟代號與反斜線（D:\...）
// - {project} 代號：路徑裡不是英數的字元都換成 -
//     macOS   /Users/user/Projects/example-app → -Users-user-Projects-example-app
//     Windows D:\work\example-app              → D--work-example-app
// - herdr：macOS 用 herdr 設的 HERDR_BIN_PATH（通常是 ~/.local/bin/herdr）；沒有時從 PATH 找 herdr
const MAC = { home: '/Users/user', root: '/Users/user/Projects/example-app', project: '-Users-user-Projects-example-app' }
const WIN = { home: 'C:\\Users\\user', root: 'D:\\work\\example-app', project: 'D--work-example-app' }
const slash = (p: string) => p.replace(/\\/g, '/')

// 沒特別指定時用 macOS
const ROOT = MAC.root
const MEMORY_DIR = MAC.home + '/.claude/projects/' + MAC.project + '/memory'
const HERDR_BIN = MAC.home + '/.local/bin/herdr'
const START = 1_000_000_000

const MEMORY_FILES: Record<string, string> = {
  'no-hotkeys.md': '---\nname: no-hotkeys\ndescription: 看板不要用快捷鍵\nmetadata:\n  type: feedback\n---\n\n不要幫我用快捷鍵。\n',
  'handoff-flow.md': '---\nname: handoff-flow\ndescription: 快取過期前自動交接\nmetadata:\n  type: project\n---\n\n交接後壓縮。\n',
}

const PANE = {
  plugin: 'baton',
  component: 'Pane',
  requestId: 'baton',
  viewport: { columns: 160, rows: 40 },
  props: {
    title: '工作看板',
    isFocused: true,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

// 共用的 stub：一個 session，記憶資料夾裡有兩則記憶，沒有交接文件
const HERDR_AGENTS = [
  { agent: 'claude', agent_status: 'working', pane_id: 'w9:p7', workspace_id: 'w9', terminal_title_stripped: '主控' },
  { agent: 'devin', name: 'reviewer', agent_status: 'blocked', pane_id: 'w9:p9', workspace_id: 'w9', terminal_title_stripped: '審 diff' },
  { agent: 'claude', agent_status: 'idle', pane_id: 'w9:p5', workspace_id: 'w9', terminal_title_stripped: '註冊開關' },
  { agent: 'grok', agent_status: 'idle', pane_id: 'wP:p1', workspace_id: 'wP' },
]

const PROJECT_SETTINGS = MAC.home + '/.claude/projects/' + MAC.project + '/baton.json'

// lane 狀態檔放在專案的 docs/lanes/status
const LANES_DIR = ROOT + '/docs/lanes/status'

function setup(
  on: any,
  extra: {
    contextPercent?: number
    handoff?: string
    herdr?: boolean
    projectSettings?: object
    // 專案覆寫檔放在改名前的 session-board.json
    legacySettings?: boolean
    progress?: string
    lanes?: Record<string, object>
    memoryFiles?: Record<string, string>
    // 改用 Windows 的路徑與環境變數（USERPROFILE、磁碟代號、反斜線）
    windows?: boolean
  } = {},
) {
  const clock = mock.clock(on, { now: START })
  const os = extra.windows ? WIN : MAC
  // 外掛看到的路徑：一律 / 分隔
  const base = slash(os.root)
  const settingsFile = slash(os.home) + '/.claude/projects/' + os.project + (extra.legacySettings ? '/session-board.json' : '/baton.json')
  const lanesDir = base + '/docs/lanes/status'
  mock.env(on, {
    ...(extra.windows ? { USERPROFILE: WIN.home } : { HOME: MAC.home }),
    ...(extra.herdr ? { HERDR_ENV: '1', HERDR_BIN_PATH: HERDR_BIN, HERDR_PANE_ID: 'w9:p7', HERDR_WORKSPACE_ID: 'w9' } : {}),
  })
  const memoryFiles = extra.memoryFiles ?? MEMORY_FILES
  // herdr agent list 的回傳可在測試中改變；runs 記錄查了幾次 agent list，argv 記錄每一次呼叫
  const herdr = { agents: HERDR_AGENTS as any[], runs: 0, argv: [] as string[][], screen: '● 正在跑測試\n  ⎿ 12 pass\n' }
  on('process.run', ($: any, e: any) => {
    const argv = e.argv ?? e.command ?? e.args ?? []
    herdr.argv.push(argv)
    if (argv[1] === 'pane' && argv[2] === 'read') return { value: { exitCode: 0, stdout: herdr.screen, stderr: '' } }
    if (argv[1] === 'agent' && argv[2] === 'list') herdr.runs += 1
    return { value: { exitCode: 0, stdout: JSON.stringify({ result: { agents: herdr.agents } }), stderr: '' } }
  })
  // herdr pane split 回傳新 pane；其他 Bash 回 ok
  on('tool.call', ($: any, e: any) => ({
    result: /pane split/.test(e.command ?? '') ? '{"result":{"pane":{"pane_id":"w9:pA"}}}' : 'ok',
  }))
  const saved = new Map<string, unknown>()
  // 專案裡的檔案（路徑 → 內容），fs.write 會寫進來
  const files = new Map<string, string>()
  if (extra.handoff) files.set(base + '/docs/HANDOFF.md', extra.handoff)
  if (extra.progress) files.set(base + '/docs/PROGRESS.md', extra.progress)
  if (extra.projectSettings) files.set(settingsFile, JSON.stringify(extra.projectSettings))
  for (const [name, value] of Object.entries(extra.lanes ?? {})) files.set(lanesDir + '/' + name + '.json', JSON.stringify(value))
  // 引擎只把本機格式的路徑當絕對路徑，其他的接在 cwd 後面：
  // macOS 上實測 D:/work/... → <cwd>/D:/work/...；Windows 上 /Users/... 應該會被補上磁碟代號（未實測）
  // 比對前去掉多出來的前綴，兩種路徑的測試在哪個系統上跑都對得上
  const norm = (p: string) => {
    const s = slash(p)
    for (const known of [base, slash(MAC.home), slash(WIN.home)]) {
      const i = s.indexOf(known)
      if (i > 0) return s.slice(i)
    }
    return s
  }
  const calls = {
    submits: [] as string[],
    contexts: [] as string[][],
    commands: [] as string[],
    compacts: [] as unknown[],
    toasts: [] as string[],
    panes: [] as string[],
  }

  on('store.get', ($: any, e: any) => ({ value: saved.get(e.key) }))
  on('store.set', ($: any, e: any) => {
    saved.set(e.key, e.value)
    return { value: undefined }
  })
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.root', () => ({ value: os.root }))
  on('session.model', () => ({ value: 'opusplan' }))
  on('session.usage', () => ({
    value: { context: { tokens: 90000, window: 200000, percent: extra.contextPercent ?? 45 }, rateLimits: [] },
  }))
  on('fs.exists', ($: any, e: any) => ({
    value: norm(e.path).endsWith('/memory') || files.has(norm(e.path)) || (norm(e.path) === lanesDir && !!extra.lanes),
  }))
  on('fs.write', ($: any, e: any) => {
    files.set(norm(e.path), e.text)
    return { value: undefined }
  })
  on('fs.list', ($: any, e: any) => {
    if (norm(e.path) === lanesDir) {
      const names = [...files.keys()].filter((p) => p.startsWith(lanesDir + '/')).map((p) => p.slice(lanesDir.length + 1))
      return { value: [...names, 'README.md'].map((name) => ({ name, kind: 'file', size: 10, isLink: false })) }
    }
    return {
      value: [
        ...Object.keys(memoryFiles).map((name) => ({ name, kind: 'file', size: 10, isLink: false })),
        { name: 'MEMORY.md', kind: 'file', size: 10, isLink: false },
      ],
    }
  })
  on('fs.read', ($: any, e: any) => {
    if (files.has(norm(e.path))) return { value: files.get(norm(e.path)) }
    const name = norm(e.path).split('/').pop()
    return { value: memoryFiles[name] ?? '' }
  })
  on('fs.stat', () => ({ value: { kind: 'file', size: 10, mtimeMs: START, isLink: false } }))
  on('command.register', () => ({ value: undefined }))
  // 引擎在輸入框上方本身什麼都不畫
  on('ui.render', ($: any, e: any) => $.ui.resolve(e).Box({ children: [] }))
  on('ui.open', () => {
    calls.panes.push('open')
    return { value: { isPlaced: true } }
  })
  on('ui.close', () => {
    calls.panes.push('close')
    return { value: undefined }
  })
  on('ui.toast', ($: any, e: any) => {
    calls.toasts.push(e.text)
    return { value: undefined }
  })
  on('session.start', () => ({ cwd: os.root }))
  on('prompt.submit', ($: any, e: any) => {
    if (e.text.startsWith("[自動交接]")) calls.submits.push(e.text)
    else calls.contexts.push([...(e.context ?? [])])
    return { text: e.text }
  })
  on('command.run', ($: any, e: any) => {
    calls.commands.push('/' + e.command + ' ' + e.args)
    return { text: 'ok' }
  })
  on('session.compact', ($: any, e: any) => {
    calls.compacts.push(e.instructions)
    return {
      messages: [{ role: 'user', text: '摘要：正在改首頁，下一步是 RWD。', toolUses: [] }],
      tokensBefore: 120000,
      tokensAfter: 18000,
    }
  })
  on('turn.start', ($: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('turn.step', async function* ($: any, e: any) {
    yield { kind: 'text', index: 0, text: 'ok' }
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  return { clock, saved, calls, files, herdr }
}

async function start($: any) {
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: ROOT })
}

async function step($: any, turnId: string) {
  const stream = $.turn.step({ turnId, index: 0, model: 'claude-test', messageCount: 1 })
  let s = await stream.next()
  while (s.done !== true) s = await stream.next()
}

test('啟動時不自動開，/board 開、再一次 /board 關', async ($, on) => {
  const { calls } = setup(on)
  await start($)
  expect(calls.panes).toEqual([])
  await $.command.run({ command: 'board', args: '' })
  expect(calls.panes).toEqual(['open'])
  await $.command.run({ command: 'board', args: '' })
  expect(calls.panes).toEqual(['open', 'close'])
  await $.command.run({ command: 'board', args: '' })
  expect(calls.panes).toEqual(['open', 'close', 'open'])
})

test('換行開關：預設截斷，打開後換行，並存起來', async ($, on) => {
  const { saved } = setup(on)
  await start($)
  const narrow = { ...PANE, props: { ...PANE.props, bodyColumns: 28 } }
  const ui = await $.ui.mount({ ...narrow, surface: 'terminal' })
  await ui.press({ key: 'tab-memory' })
  const before = await ui.find({ type: 'Text', text: MEMORY_DIR })
  expect(before.props.wrap).toBe('truncate-middle')
  await ui.press({ key: 'toggle-wrap' })
  const after = await ui.find({ type: 'Text', text: MEMORY_DIR })
  expect(after.props.wrap).toBe('wrap')
  expect(saved.get('wrap')).toBe(true)
  await ui.unmount()
})

test('窄寬度下兩種介面都畫得出來', async ($, on) => {
  setup(on)
  await start($)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 24 }, surface })
    expect(await ui.find({ key: 'toggle-auto' })).toBeDefined()
    await ui.press({ key: 'tab-memory' })
    expect(await ui.find({ key: 'mem-no-hotkeys.md' })).toBeDefined()
    await ui.unmount()
  }
})

test('記憶分頁依類型分組，點標題展開全文', async ($, on) => {
  setup(on)
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab-memory' })
  expect(await ui.find({ type: 'Text', text: MEMORY_DIR })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '叮囑（1）' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '專案（1）' })).toBeDefined()
  expect(await ui.find({ key: 'mem-body-no-hotkeys.md' })).toBeUndefined()
  await ui.press({ key: 'mem-no-hotkeys.md' })
  expect(await ui.find({ key: 'mem-body-no-hotkeys.md' })).toBeDefined()
  await ui.unmount()
})

test('不在 herdr 裡時沒有 Herdr 分頁', async ($, on) => {
  setup(on)
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ key: 'tab-herdr' })).toBeUndefined()
  await ui.unmount()
})

test('Herdr 分頁列出這個 session 指揮的 agent 與狀態', async ($, on) => {
  const { calls } = setup(on, { herdr: true })
  await start($)
  await $.command.run({ command: 'board', args: '' })
  await $.tool.call({ tool: 'Bash', command: 'herdr agent prompt reviewer "幫我審 diff" --wait --timeout 120000' })
  await $.tool.call({ tool: 'Bash', command: 'herdr pane split --current --direction right --no-focus' })
  // 自己的 pane 不算
  await $.tool.call({ tool: 'Bash', command: 'herdr pane read w9:p7 --lines 20' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab-herdr' })
  expect(await ui.find({ type: 'Text', text: '這個 session 指揮的（2）' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /reviewer（devin） w9:p9 · blocked/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /派工作「幫我審 diff」/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /w9:pA · 已結束或不是 agent pane/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /同工作區的其他 agent（1）/ })).toBeDefined()
  await ui.unmount()
  expect(calls.toasts).toEqual([])
})

test('自動交接開關會存起來', async ($, on) => {
  const { saved } = setup(on)
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'toggle-auto' })
  expect(saved.get('auto')).toBe(false)
  await ui.unmount()
})

test('快取剩 5 分鐘時送出交接指示，交接那輪結束後壓縮', async ($, on) => {
  const { clock, calls } = setup(on)
  await start($)
  await $.command.run({ command: 'board', args: '' })
  await $.prompt.submit({ text: '幫我改首頁', origin: { kind: 'composer' }, wait: false })
  await $.turn.start({ turnId: 't1', text: '幫我改首頁' })
  await step($, 't1')
  await $.turn.complete({ turnId: 't1', answer: '改好了', durationMs: 1000, isAborted: false, usage: null })

  // 54 分鐘：還沒到
  await clock.advance(54 * 60 * 1000)
  expect(calls.submits.length).toBe(0)
  // 55 分鐘：剩 5 分鐘，觸發交接
  await clock.advance(60 * 1000 + 1000)
  expect(calls.submits.length).toBe(1)
  expect(calls.submits[0]).toContain('[自動交接]')
  expect(calls.submits[0]).toContain(ROOT + '/docs/HANDOFF.md')

  // 交接那一輪
  await $.turn.start({ turnId: 't2', text: calls.submits[0] })
  await step($, 't2')
  await $.turn.complete({ turnId: 't2', answer: '已寫好', durationMs: 1000, isAborted: false, usage: null })
  await clock.advance(2000)
  expect(calls.compacts.length).toBe(1)

  // 壓縮後不會再觸發，直到使用者送出新的 prompt
  await clock.advance(60 * 60 * 1000)
  expect(calls.submits.length).toBe(1)
})

test('新 session 的第一個 prompt 附上交接文件，之後的不附', async ($, on) => {
  const { calls } = setup(on, { handoff: '# 交接\n下一步：做 RWD' })
  await start($)
  await $.prompt.submit({ text: '繼續', origin: { kind: 'composer' }, wait: false })
  await $.prompt.submit({ text: '好', origin: { kind: 'composer' }, wait: false })
  expect(calls.contexts[0].length).toBe(1)
  expect(calls.contexts[0][0]).toContain('baton 交接機制')
  expect(calls.contexts[0][0]).toContain('下一步：做 RWD')
  expect(calls.contexts[0][0]).toContain('還沒開「任務」分頁')
  expect(calls.contexts[0][0]).toContain('baton.json')
  expect(calls.contexts[1]).toEqual([])
})

test('壓縮後存下摘要、看板可展開，下一個 prompt 再附一次交接文件', async ($, on) => {
  const { calls, files } = setup(on, { handoff: '# 交接\n下一步：做 RWD' })
  await start($)
  await $.prompt.submit({ text: '繼續', origin: { kind: 'composer' }, wait: false })
  await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: '舊對話', toolUses: [] }] })
  const saved = files.get(ROOT + '/docs/HANDOFF.compact.md')
  expect(saved).toContain('摘要：正在改首頁')

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const toggle = await ui.find({ key: 'toggle-compact' })
  expect(toggle.props.label).toContain('120k → 18k tokens')
  expect(await ui.find({ key: 'compact-summary' })).toBeUndefined()
  await ui.press({ key: 'toggle-compact' })
  expect(await ui.find({ key: 'compact-summary' })).toBeDefined()
  await ui.unmount()

  await $.prompt.submit({ text: '接著做', origin: { kind: 'composer' }, wait: false })
  expect(calls.contexts[1][0]).toContain('下一步：做 RWD')
})

test('沒輸入過 /board 的 session 不自動交接', async ($, on) => {
  const { clock, calls } = setup(on)
  await start($)
  await $.turn.start({ turnId: 't1', text: 'hi' })
  await step($, 't1')
  await $.turn.complete({ turnId: 't1', answer: 'hi', durationMs: 10, isAborted: false, usage: null })
  await clock.advance(56 * 60 * 1000)
  expect(calls.submits.length).toBe(0)
})

test('上下文太小時不交接', async ($, on) => {
  const { clock, calls } = setup(on, { contextPercent: 5 })
  await start($)
  await $.command.run({ command: 'board', args: '' })
  await $.turn.start({ turnId: 't1', text: 'hi' })
  await step($, 't1')
  await $.turn.complete({ turnId: 't1', answer: 'hi', durationMs: 10, isAborted: false, usage: null })
  await clock.advance(56 * 60 * 1000)
  expect(calls.submits.length).toBe(0)
})

// 走到快取剩不到 5 分鐘、送出交接指示為止
async function reachHandoff($: any, clock: any) {
  await $.command.run({ command: 'board', args: '' })
  await $.prompt.submit({ text: '幫我改首頁', origin: { kind: 'composer' }, wait: false })
  await $.turn.start({ turnId: 't1', text: '幫我改首頁' })
  await step($, 't1')
  await $.turn.complete({ turnId: 't1', answer: '改好了', durationMs: 1000, isAborted: false, usage: null })
  await clock.advance(55 * 60 * 1000 + 1000)
}

const PROGRESS = [
  '# 進度',
  '',
  '## 交接（10-03 21:50；以本節為準）',
  '',
  '### 待辦',
  '- 下一步：效能',
  '',
  '```md',
  '## 不是標題',
  '```',
  '',
  '## 交接（10-02，已取代）',
  '舊的內容',
].join('\n')

test('專案覆寫檔：讀專案自己的文件的「## 交接」一節，交接指示只更新那一節', async ($, on) => {
  const { clock, calls, files } = setup(on, {
    progress: PROGRESS,
    projectSettings: { handoff_path: 'docs/PROGRESS.md', handoff_section: '## 交接' },
  })
  await start($)
  await $.prompt.submit({ text: '繼續', origin: { kind: 'composer' }, wait: false })
  const brief = calls.contexts[0][0]
  expect(brief).toContain(ROOT + '/docs/PROGRESS.md')
  expect(brief).toContain('下一步：效能')
  expect(brief).toContain('## 不是標題')
  expect(brief).not.toContain('舊的內容')

  // 壓縮摘要不寫進專案文件旁邊，而是全域交接文件旁邊
  await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: '舊對話', toolUses: [] }] })
  expect(files.has(ROOT + '/docs/PROGRESS.compact.md')).toBe(false)
  expect(files.get(ROOT + '/docs/HANDOFF.compact.md')).toContain('摘要：')

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /只讀「## 交接」一節/ })).toBeDefined()
  await ui.unmount()

  await reachHandoff($, clock)
  expect(calls.submits.length).toBe(1)
  expect(calls.submits[0]).toContain('「## 交接」那一節')
  expect(calls.submits[0]).not.toContain('（整份覆寫、精簡）')

  // 交接那一輪結束後壓縮；mod 本身不改專案文件
  await $.turn.start({ turnId: 't2', text: calls.submits[0] })
  await step($, 't2')
  await $.turn.complete({ turnId: 't2', answer: '已寫好', durationMs: 1000, isAborted: false, usage: null })
  await clock.advance(2000)
  expect(calls.compacts.length).toBe(2)
  expect(files.get(ROOT + '/docs/PROGRESS.md')).toBe(PROGRESS)
})

test('沒有 baton.json 時讀改名前的 session-board.json', async ($, on) => {
  const { calls } = setup(on, {
    progress: PROGRESS,
    legacySettings: true,
    projectSettings: { handoff_path: 'docs/PROGRESS.md', handoff_section: '## 交接' },
  })
  await start($)
  await $.prompt.submit({ text: '繼續', origin: { kind: 'composer' }, wait: false })
  const brief = calls.contexts[0][0]
  expect(brief).toContain(ROOT + '/docs/PROGRESS.md')
  expect(brief).toContain('下一步：效能')
})

test('使用者在交接指示之前送出的那一輪，不會被當成交接而觸發壓縮', async ($, on) => {
  const { clock, calls } = setup(on)
  await start($)
  await reachHandoff($, clock)
  expect(calls.submits.length).toBe(1)
  // 使用者的一輪先跑
  await $.turn.start({ turnId: 'u2', text: '等一下，先看這個' })
  await step($, 'u2')
  await $.turn.complete({ turnId: 'u2', answer: '好', durationMs: 1000, isAborted: false, usage: null })
  await clock.advance(5000)
  expect(calls.compacts.length).toBe(0)
  // 接著交接那一輪
  await $.turn.start({ turnId: 't2', text: calls.submits[0] })
  await step($, 't2')
  await $.turn.complete({ turnId: 't2', answer: '已寫好', durationMs: 1000, isAborted: false, usage: null })
  await clock.advance(2000)
  expect(calls.compacts.length).toBe(1)
})

test('快取 5 分鐘時不自動交接', { options: { cache_ttl: '5m' } }, async ($, on) => {
  const { clock, calls } = setup(on)
  await start($)
  await $.command.run({ command: 'board', args: '' })
  await $.prompt.submit({ text: 'hi', origin: { kind: 'composer' }, wait: false })
  await $.turn.start({ turnId: 't1', text: 'hi' })
  await step($, 't1')
  await $.turn.complete({ turnId: 't1', answer: 'hi', durationMs: 10, isAborted: false, usage: null })
  await clock.advance(4 * 60 * 1000)
  expect(calls.submits.length).toBe(0)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: '快取 5m，不自動交接' })).toBeDefined()
  await ui.unmount()
})

test('離開超過 away_hours 就不自動交接', { options: { away_hours: '2' } }, async ($, on) => {
  const { clock, calls } = setup(on)
  await start($)
  // 開一次看板啟用自動交接，再關掉（關著時每秒不重畫，模擬數小時比較快）
  await $.command.run({ command: 'board', args: '' })
  await $.command.run({ command: 'board', args: '' })
  await $.prompt.submit({ text: 'hi', origin: { kind: 'composer' }, wait: false })
  // 70 分鐘後才有一輪（不是使用者送出的，例如排程）；快取剩 5 分鐘時已離開超過 2 小時
  await clock.advance(70 * 60 * 1000)
  await $.turn.start({ turnId: 't1', text: '' })
  await step($, 't1')
  await $.turn.complete({ turnId: 't1', answer: 'ok', durationMs: 10, isAborted: false, usage: null })
  await clock.advance(56 * 60 * 1000)
  expect(calls.submits.length).toBe(0)
})

test('指揮的 agent 都閒下來後停止查 herdr，再下指令時恢復', async ($, on) => {
  const { clock, herdr } = setup(on, { herdr: true })
  await start($)
  await $.tool.call({ tool: 'Bash', command: 'herdr agent prompt reviewer "幫我審 diff"' })
  // reviewer 還在 blocked：持續查
  await clock.advance(2 * 60 * 1000)
  const busy = herdr.runs
  await clock.advance(30 * 1000)
  expect(herdr.runs).toBeGreaterThan(busy)
  // reviewer 完成並閒置：再查到一次之後就停
  herdr.agents = HERDR_AGENTS.map((a) => (a.name === 'reviewer' ? { ...a, agent_status: 'idle' } : a))
  await clock.advance(10 * 1000)
  const settled = herdr.runs
  await clock.advance(5 * 60 * 1000)
  expect(herdr.runs).toBe(settled)
  // 再派一次工作
  herdr.agents = HERDR_AGENTS
  await $.tool.call({ tool: 'Bash', command: 'herdr agent prompt reviewer "再看一次"' })
  await clock.advance(30 * 1000)
  expect(herdr.runs).toBeGreaterThan(settled + 1)
})

const BAND = {
  plugin: 'baton',
  component: 'AbovePrompt',
  requestId: 'above-prompt',
  viewport: { columns: 160, rows: 40 },
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 160, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

test('輸入框上方的按鈕：看板關著時出現，點了打開看板', async ($, on) => {
  const { calls } = setup(on)
  await start($)
  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ ...BAND, surface } as any)
    expect(await band.find({ key: 'open-board' })).toBeDefined()
    await band.unmount()
  }
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' } as any)
  await band.press({ key: 'open-board' })
  expect(calls.panes).toEqual(['open'])
  expect(await band.find({ key: 'open-board' })).toBeUndefined()
  await band.unmount()
})

test('launcher_button 關掉時不顯示按鈕', { options: { launcher_button: false } }, async ($, on) => {
  setup(on)
  await start($)
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' } as any)
  expect(await band.find({ key: 'open-board' })).toBeUndefined()
  await band.unmount()
})

// ── 任務分頁（lane 狀態檔） ──
const UPDATED = new Date(START).toISOString()
const LANES = {
  architect: {
    lane: 'architect',
    title: '架構負責人：驗收與部署',
    state: 'working',
    steps: [
      { id: 'A1', title: '任務看板', state: 'doing' },
      { id: 'A2', title: '驗收註冊開關', state: 'todo' },
    ],
    notes: ['最近的 commit 都還沒 push'],
    updated: UPDATED,
  },
  ops: {
    lane: 'ops',
    title: '後台多帳號',
    pane: 'w9:p9',
    state: 'blocked',
    needs: '要刪除 2 個舊 secret 嗎？',
    report: 'docs/ops-report.md',
    steps: [
      { id: 'O1', title: '帳號清單', state: 'done' },
      { id: 'O2', title: '清舊 secret', state: 'doing' },
      { id: 'O3', title: '整合測試', state: 'todo' },
    ],
    updated: UPDATED,
  },
  signup: {
    lane: 'signup',
    title: '會員註冊開關',
    pane: 'w9:p5',
    state: 'working',
    steps: [
      { id: 'R1', title: '站台設定', state: 'done' },
      { id: 'R2', title: '伺服器端 403', state: 'done' },
      { id: 'R3', title: '測試與 commit', state: 'doing' },
      { id: 'R4', title: '舊版相容', state: 'skip' },
    ],
    updated: UPDATED,
  },
  landing: { lane: 'landing', title: '形象頁', state: 'done', steps: [{ id: 'S1', title: '部署', state: 'done' }], updated: UPDATED },
}
const LANE_SETTINGS = { tasks_dir: 'docs/lanes/status', handoff_path: 'docs/PROGRESS.md', handoff_section: '/以本節為準/' }

test('任務分頁：要處理的在前，每條一到兩行，帶百分比；完成的收起來', async ($, on) => {
  setup(on, { herdr: true, projectSettings: LANE_SETTINGS, lanes: LANES })
  await start($)
  await $.command.run({ command: 'board', args: '' })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ key: 'tab-tasks' })).toBeDefined()
    expect(await ui.find({ key: 'tab-herdr' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: '需要處理 1' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /└ 等你：要刪除 2 個舊 secret 嗎？/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '  33%' })).toBeDefined()
    // signup：跳過的步驟不算，2/3
    expect(await ui.find({ type: 'Text', text: /2\/3 · R3 測試與 commit/ })).toBeDefined()
    expect(await ui.find({ key: 'task-landing' })).toBeUndefined()
    await ui.press({ key: 'toggle-quiet' })
    expect(await ui.find({ key: 'task-landing' })).toBeDefined()
    await ui.press({ key: 'toggle-quiet' })
    await ui.unmount()
  }
})

// 返回時捲回原本那一列（$.ui.scroll）要引擎算位置，測試工具沒有，留給實機確認
test('點開 lane 是子頁：步驟、等你決定、即時畫面；返回回到列表', async ($, on) => {
  const { calls, herdr } = setup(on, { herdr: true, projectSettings: LANE_SETTINGS, lanes: LANES })
  await start($)
  await $.command.run({ command: 'board', args: '' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'task-ops' })
  expect(await ui.find({ key: 'nav-back' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /任務 › ops/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '◐ O2 清舊 secret' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '等你決定' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '● 正在跑測試' })).toBeDefined()
  expect(herdr.argv.some((a) => a.join(' ') === HERDR_BIN + ' pane read w9:p9 --lines 60 --source recent')).toBe(true)
  await ui.press({ key: 'nav-back' })
  expect(await ui.find({ key: 'nav-back' })).toBeUndefined()
  expect(await ui.find({ key: 'task-ops' })).toBeDefined()
  await ui.unmount()
})

test('子頁裡可以回覆 lane、送按鍵，報告是再下一層，返回回到 lane 子頁', async ($, on) => {
  const { herdr, files } = setup(on, { herdr: true, projectSettings: LANE_SETTINGS, lanes: LANES })
  files.set(ROOT + '/docs/ops-report.md', '# STATUS: BLOCKED\n\n舊 secret 兩個')
  await start($)
  await $.command.run({ command: 'board', args: '' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'task-ops' })
  await ui.input({ key: 'lane-reply', text: '可以刪' })
  expect(herdr.argv.some((a) => a.join(' ') === HERDR_BIN + ' agent prompt w9:p9 可以刪')).toBe(true)
  await ui.press({ key: 'lane-key-1' })
  expect(herdr.argv.some((a) => a.join(' ') === HERDR_BIN + ' agent send-keys w9:p9 1')).toBe(true)
  await ui.press({ key: 'lane-report' })
  expect(await ui.find({ type: 'Text', text: /任務 › ops › 報告/ })).toBeDefined()
  expect(await ui.find({ key: 'report-ops' })).toBeDefined()
  await ui.press({ key: 'nav-back' })
  expect(await ui.find({ type: 'Text', text: /任務 › ops$/ })).toBeDefined()
  await ui.unmount()
})

test('Herdr 看到對話框在等確認時，進行中的 lane 也列到需要處理', async ($, on) => {
  const { herdr } = setup(on, { herdr: true, projectSettings: LANE_SETTINGS, lanes: { signup: LANES.signup } })
  herdr.agents = HERDR_AGENTS.map((a) => (a.pane_id === 'w9:p5' ? { ...a, agent_status: 'blocked' } : a))
  await start($)
  await $.command.run({ command: 'board', args: '' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: '需要處理 1' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /└ 對話框等確認/ })).toBeDefined()
  await ui.unmount()
})

test('lane 變成等你時跳通知；新 session 的交接只帶一覽與自己的步驟', async ($, on) => {
  const { clock, calls, files } = setup(on, {
    projectSettings: LANE_SETTINGS,
    lanes: LANES,
    progress: '# 進度\n\n## 當前交接（以本節為準）\n\n很長的交接內容',
  })
  await start($)
  await $.prompt.submit({ text: '繼續', origin: { kind: 'composer' }, wait: false })
  const brief = calls.contexts[0][0]
  expect(brief).toContain(ROOT + '/docs/lanes/status/<lane>.json')
  expect(brief).toContain('⚠ ops：後台多帳號 33%（1/3）· 等你：要刪除 2 個舊 secret 嗎？')
  expect(brief).toContain('◐ A1 任務看板')
  expect(brief).not.toContain('還沒開「任務」分頁')
  expect(brief).toContain('• 最近的 commit 都還沒 push')
  expect(brief).not.toContain('很長的交接內容')

  files.set(LANES_DIR + '/signup.json', JSON.stringify({ ...LANES.signup, state: 'blocked', needs: '註冊預設要開還是關？' }))
  await clock.advance(31 * 1000)
  expect(calls.toasts).toContain('signup 等你：註冊預設要開還是關？')
})

test('lane 模式的自動交接：要求更新自己的狀態檔', async ($, on) => {
  const { clock, calls } = setup(on, { projectSettings: LANE_SETTINGS, lanes: LANES })
  await start($)
  await reachHandoff($, clock)
  expect(calls.submits[0]).toContain(ROOT + '/docs/lanes/status/architect.json')
  expect(calls.submits[0]).toContain('notes')
})

// ── 記憶分層 ──
const LAYERED = {
  'reply.md': '---\nname: reply-language\ndescription: 回覆語言\nmetadata:\n  type: feedback\n  layer: user\n---\n\n回覆用使用者的語言。\n',
  'lines.md': '---\nname: module-boundary\ndescription: 模組邊界\nmetadata:\n  type: project\n  layer: project\n---\n\n模組之間互不 import。\n',
  'ops.md': '---\nname: ops-console\ndescription: 後台\nmetadata:\n  type: project\n  layer: workstream\n  lane: ops\n---\n\n後台。\n',
  'now.md': '---\nname: phase-now\ndescription: 目前階段\nmetadata:\n  type: project\n  layer: phase\n  review_by: 1970-01-01\n---\n\n目前階段。\n',
  'old.md': '---\nname: old-note\ndescription: 還沒分層\nmetadata:\n  type: reference\n---\n\n舊的。\n',
}

test('記憶依 layer 分層：使用者、專案展開，工作線、階段收起；過期的階段記憶標出來', async ($, on) => {
  setup(on, { memoryFiles: LAYERED })
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab-memory' })
  expect(await ui.find({ key: 'mem-reply.md' })).toBeDefined()
  expect(await ui.find({ key: 'mem-lines.md' })).toBeDefined()
  expect(await ui.find({ key: 'mem-ops.md' })).toBeUndefined()
  const phase = await ui.find({ key: 'layer-phase' })
  expect(phase.props.label).toContain('階段（1） ⚠ 1 則該檢查了')
  expect(await ui.find({ key: 'mem-old.md' })).toBeDefined()
  await ui.press({ key: 'layer-workstream' })
  expect(await ui.find({ key: 'mem-ops.md' })).toBeDefined()
  await ui.unmount()
})

test('工作線的記憶出現在對應 lane 的子頁', async ($, on) => {
  setup(on, { herdr: true, projectSettings: LANE_SETTINGS, lanes: LANES, memoryFiles: LAYERED })
  await start($)
  await $.command.run({ command: 'board', args: '' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'task-ops' })
  expect(await ui.find({ type: 'Text', text: '這條線的記憶（1）' })).toBeDefined()
  expect(await ui.find({ key: 'lane-mem-ops.md' })).toBeDefined()
  await ui.unmount()
})

test('/handoff 不用開看板也能立即交接，交接中再下一次不會重送', async ($, on) => {
  const { clock, calls } = setup(on)
  await start($)
  await $.command.run({ command: 'handoff', args: '' })
  await clock.advance(10)
  expect(calls.submits.length).toBe(1)
  expect(calls.submits[0]).toContain('[自動交接]')
  await $.command.run({ command: 'handoff', args: '' })
  await clock.advance(10)
  expect(calls.submits.length).toBe(1)
  expect(calls.toasts).toContain('已經在交接中')

  // 引擎實際會在外掛送的訊息前加一段說明
  await $.turn.start({ turnId: 't1', text: 'The baton plugin sent a message: ' + calls.submits[0] })
  await step($, 't1')
  await $.turn.complete({ turnId: 't1', answer: '已寫好', durationMs: 1000, isAborted: false, usage: null })
  await clock.advance(2000)
  expect(calls.compacts.length).toBe(1)
})

test('交接指示送出後一直沒開始，過一分鐘再按會重送', async ($, on) => {
  const { clock, calls } = setup(on)
  await start($)
  await $.command.run({ command: 'handoff', args: '' })
  await clock.advance(10)
  expect(calls.submits.length).toBe(1)
  await clock.advance(61000)
  await $.command.run({ command: 'handoff', args: '' })
  await clock.advance(10)
  expect(calls.submits.length).toBe(2)
})

// ── 路徑：macOS 與 Windows ──
test('macOS：~ 用 HOME 展開，{project} 是專案路徑換成 - 的代號', { options: { memory_dir: '~/notes/{project}' } }, async ($, on) => {
  const { calls } = setup(on)
  await start($)
  await $.prompt.submit({ text: '繼續', origin: { kind: 'composer' }, wait: false })
  const brief = calls.contexts[0][0]
  expect(brief).toContain('記憶資料夾：/Users/user/notes/-Users-user-Projects-example-app')
  expect(brief).toContain('交接文件：/Users/user/Projects/example-app/docs/HANDOFF.md')
  expect(brief).toContain('/Users/user/.claude/projects/-Users-user-Projects-example-app/baton.json')
})

test('Windows：USERPROFILE、磁碟代號與反斜線都展開成 / 分隔的路徑', async ($, on) => {
  const { calls } = setup(on, { windows: true, handoff: '# 交接\n下一步：做 RWD' })
  await start($)
  await $.prompt.submit({ text: '繼續', origin: { kind: 'composer' }, wait: false })
  const brief = calls.contexts[0][0]
  expect(brief).toContain('交接文件：D:/work/example-app/docs/HANDOFF.md')
  expect(brief).toContain('下一步：做 RWD')
  expect(brief).toContain('記憶資料夾：C:/Users/user/.claude/projects/D--work-example-app/memory')
  expect(brief).toContain('C:/Users/user/.claude/projects/D--work-example-app/baton.json')
})
