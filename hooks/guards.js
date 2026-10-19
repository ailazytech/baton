// 守門的判斷邏輯（不碰 $、不放介面文字）：寫成文字還一再被違反的要求，起草成工具呼叫前的正規表達式比對，使用者同意才生效。
// 移植自 ctx-handoff-mod（MIT，Copyright (c) 2026 cablate）的 hooks/guards.ts。
// 守門存在專案覆寫檔旁的 baton-guards.json，使用者在對話裡同意後由 Claude 直接改檔裡的 state。
// 給模型的起草提示、給 Claude 的詢問與命中提醒在 register.js 的 I18N（guardPrompt、guardAsk、guardHead）

export const GUARD_MIN_COUNT = 3
// 每段新對話開頭最多請 Claude 問幾條草稿
export const GUARD_ASK_ITEMS = 3
export const PATTERN_MAX = 300
export const GUARDS_START = '<<<GUARDS'
export const GUARDS_END = 'GUARDS>>>'
const MODES = ['deny', 'remind']
// tool.call 輸入裡不屬於工具參數的鍵
const RESERVED_KEYS = new Set(['tool', 'tool_use_id', 'consent', 'agentId'])

const clip = (text, max) => {
  const s = String(text ?? '')
  return s.length > max ? s.slice(0, max) + '…' : s
}

// 比對對象：工具參數裡的字串值（Bash 就是 command），其他值轉成 JSON，以換行串起來
export function inputText(input) {
  return Object.entries(input)
    .filter(([k, v]) => !RESERVED_KEYS.has(k) && v !== undefined)
    .map(([, v]) => (typeof v === 'string' ? v : JSON.stringify(v)))
    .join('\n')
}

const toolMatches = (pattern, tool) => (pattern.endsWith('*') ? tool.startsWith(pattern.slice(0, -1)) : pattern === tool)

export function guardHits(g, tool, text) {
  if (!toolMatches(g.tool, tool)) return false
  try {
    if (!new RegExp(g.match, 'i').test(text)) return false
    return !g.unless || !new RegExp(g.unless, 'i').test(text)
  } catch {
    return false
  }
}

// 先篩出啟用中且工具名稱符合的守門，沒有候選時不序列化參數（省下每次寫大檔的 JSON.stringify）
export function findGuardHit(guards, tool, input) {
  const active = guards.filter((g) => g.state === 'on' && toolMatches(g.tool, tool))
  if (!active.length) return undefined
  const text = inputText(input)
  return active.find((g) => guardHits(g, tool, text))
}

// 寫成文字還擋不住的才升級成守門：放進專案之後又被糾正（次數比放進去時多），或使用者不要放進專案、卻已經講了 3 次。
// 已有守門（任何狀態，含使用者說不要的）不再提
export function guardCandidates(memories, guards) {
  return memories.filter((m) => {
    if (m.type !== 'feedback' || guards.some((g) => g.rule === m.name)) return false
    if (m.promoted === 'declined') return m.count >= GUARD_MIN_COUNT
    return !!m.promoted && m.count > (m.promotedCount || m.count)
  })
}

// 解析模型的草稿：驗證樣式與範例（違規的要擋、正確的要放行），不符就丟掉
export function parseGuards(text, names) {
  const out = []
  const rejected = []
  const start = text.indexOf(GUARDS_START)
  const end = text.indexOf(GUARDS_END, start + 1)
  if (start === -1 || end === -1) return { out, rejected: ['no markers'] }
  for (const line of text.slice(start + GUARDS_START.length, end).split('\n')) {
    if (!line.trim()) continue
    try {
      const g = JSON.parse(line)
      const str = (k) => (typeof g[k] === 'string' && g[k].trim() ? g[k] : undefined)
      const rule = str('rule')
      const tool = str('tool')
      const match = str('match')
      const message = str('message')
      const unless = str('unless')
      const mode = MODES.find((m) => m === g.mode)
      if (!rule || !names.has(rule)) throw new Error('not a candidate rule')
      if (!tool || !/^[\w.-]+\*?$/.test(tool)) throw new Error('bad tool name')
      if (!match || !message || !mode) throw new Error('missing fields')
      for (const pattern of [match, unless]) {
        if (pattern === undefined) continue
        if (pattern.length > PATTERN_MAX) throw new Error('pattern too long')
        new RegExp(pattern, 'i')
      }
      const bad = str('bad')
      const good = str('good')
      if (!bad || !good) throw new Error('missing examples')
      const probe = { tool, match, ...(unless ? { unless } : {}) }
      const self = tool.replace(/\*$/, '')
      if (!guardHits(probe, self, bad)) throw new Error('bad example not caught')
      if (guardHits(probe, self, good)) throw new Error('good example caught')
      if (out.some((o) => o.rule === rule)) throw new Error('duplicate')
      out.push({ ...probe, rule, mode, message, bad, good })
    } catch (err) {
      rejected.push(clip(line.trim(), 80) + ': ' + (err instanceof Error ? err.message : String(err)))
    }
  }
  return { out, rejected }
}

// 草稿加上編號與狀態
export function withProposals(out, guards, at) {
  let id = guards.reduce((n, g) => Math.max(n, g.id), 0)
  return out.map((g) => ({ id: ++id, ...g, state: 'proposed', at }))
}

// /guard on|off|drop N、/guard mode N deny|remind；不合法回 undefined
export function applyGuardChange(guards, action, id, mode) {
  const g = guards.find((x) => x.id === id)
  if (!g) return undefined
  if (action === 'drop') return guards.filter((x) => x !== g)
  if (action === 'on' || action === 'off') return guards.map((x) => (x === g ? { ...x, state: action } : x))
  if (action === 'mode' && MODES.includes(mode)) return guards.map((x) => (x === g ? { ...x, mode } : x))
  return undefined
}
