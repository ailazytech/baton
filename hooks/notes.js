// 自動整理筆記的判斷邏輯（不碰 $、不放介面文字）：解析與驗證整理模型輸出的動作、改寫記憶檔的 frontmatter、
// 找出講了 3 次以上該放進專案的要求。做法參考 ctx-handoff-mod（MIT，Copyright (c) 2026 cablate）的 hooks/distill.ts，
// 但記憶寫進現有的記憶資料夾（一則一檔＋MEMORY.md 索引），次數與日期記在 frontmatter 的 metadata。
// 給整理模型的提示與給 Claude 的說明在 register.js 的 I18N（distillPrompt、promote）

export const ACTIONS_START = '<<<ACTIONS'
export const ACTIONS_END = 'ACTIONS>>>'
// 講幾次就請 Claude 放進專案
export const PROMOTE_COUNT = 3
// 每段新對話開頭最多請 Claude 處理幾條
export const PROMOTE_ITEMS = 3
// 提示裡每則訊息最多幾個字：使用者的話盡量完整，Claude 的回答只要上下文
export const USER_MAX = 2000
export const ASSISTANT_MAX = 600

const NAME_RE = /^[a-z0-9][a-z0-9-]{1,60}$/
const TYPES = ['feedback', 'user']
const LAYERS = ['user', 'project']
const QUOTE_MIN = 4
// 看起來像金鑰或密碼的內容不記
const SECRET =
  /\b(?:sk|pk|rk|ghp|gho|ghs|xox[abpr])[-_][A-Za-z0-9_-]{12,}|\bAKIA[0-9A-Z]{16}\b|-----BEGIN [A-Z ]*PRIVATE KEY|\b[A-Fa-f0-9]{40,}\b|\b[A-Za-z0-9+/]{48,}={0,2}|(?:password|passwd|密碼|token|api[_ -]?key|secret)\s*[:=：]\s*\S{6,}/i

export const looksSecret = (text) => SECRET.test(String(text ?? ''))
export const squash = (text) => String(text ?? '').replace(/\s+/g, ' ').trim()
export const clip = (text, max) => {
  const s = String(text ?? '')
  return s.length > max ? s.slice(0, max) + '…' : s
}

// 解析整理模型的輸出：回傳要新增與加次數的記憶、被丟掉的原因（給 /distill 與看板顯示數量用，不翻譯）
// existing：現有記憶的 name 集合；userTexts：這段對話裡使用者親手打的訊息
export function parseActions(text, existing, userTexts) {
  const adds = []
  const confirms = []
  const rejected = []
  const start = text.indexOf(ACTIONS_START)
  const end = text.indexOf(ACTIONS_END, start + 1)
  if (start === -1 || end === -1) return { adds, confirms, rejected: ['no markers'] }
  const said = userTexts.map(squash)
  const quoted = (quote) => {
    const q = squash(quote)
    return q.length >= QUOTE_MIN && said.some((s) => s.includes(q))
  }
  const seen = new Set()
  for (const line of text.slice(start + ACTIONS_START.length, end).split('\n')) {
    if (!line.trim()) continue
    try {
      const a = JSON.parse(line)
      const str = (k) => (typeof a[k] === 'string' && a[k].trim() ? a[k].trim() : '')
      const name = str('name')
      const quote = str('quote')
      // 一定要附使用者的原話，而且真的出現在使用者打的訊息裡：擋掉模型自己編的、或把 Claude 的話當成使用者說的
      if (!quoted(quote)) throw new Error('quote not found in user messages')
      if (looksSecret(quote) || looksSecret(a.body)) throw new Error('looks like a secret')
      if (a.op === 'confirm' || (a.op === 'add' && existing.has(name))) {
        if (!existing.has(name)) throw new Error('no such memory')
        if (seen.has(name)) continue
        seen.add(name)
        confirms.push({ name, quote })
        continue
      }
      if (a.op !== 'add') throw new Error('unknown op')
      if (!NAME_RE.test(name)) throw new Error('bad name')
      if (seen.has(name)) continue
      const type = TYPES.includes(a.type) ? a.type : ''
      if (!type) throw new Error('type must be feedback or user')
      const description = squash(str('description'))
      const body = str('body')
      if (!description || !body) throw new Error('missing description or body')
      seen.add(name)
      adds.push({
        name,
        title: squash(str('title')) || name,
        type,
        layer: LAYERS.includes(a.layer) ? a.layer : 'project',
        description,
        body,
        quote,
      })
    } catch (err) {
      rejected.push(clip(line.trim(), 80) + ': ' + (err instanceof Error ? err.message : String(err)))
    }
  }
  return { adds, confirms, rejected }
}

// frontmatter 的 metadata 底下設定幾個值（有就改、沒有就加）；沒有 frontmatter 時補一個。內文不動
export function setMeta(raw, values) {
  const text = String(raw).replace(/\r\n/g, '\n')
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  const front = m ? m[1].split('\n') : []
  const rest = m ? m[2] : text
  let at = front.findIndex((l) => /^metadata:\s*$/.test(l))
  if (at === -1) {
    front.push('metadata:')
    at = front.length - 1
  }
  // metadata 底下縮排的那幾行
  let endAt = at + 1
  while (endAt < front.length && /^\s+\S/.test(front[endAt])) endAt += 1
  for (const [key, value] of Object.entries(values)) {
    const lineText = '  ' + key + ': ' + value
    const i = front.slice(at + 1, endAt).findIndex((l) => new RegExp('^\\s+' + key + ':').test(l))
    if (i === -1) {
      front.splice(endAt, 0, lineText)
      endAt += 1
    } else {
      front[at + 1 + i] = lineText
    }
  }
  return '---\n' + front.join('\n') + '\n---\n' + (rest.startsWith('\n') ? rest : '\n' + rest)
}

// YAML 的值：簡單的字串原樣寫，含冒號、井號或開頭是符號的加引號
const yamlText = (s) => (/^[\w一-鿿][^:#]*$/.test(s) ? s : JSON.stringify(s))

export function newMemoryFile(a, today) {
  return [
    '---',
    'name: ' + a.name,
    'description: ' + yamlText(a.description),
    'metadata:',
    '  type: ' + a.type,
    '  layer: ' + a.layer,
    '  count: 1',
    '  last_seen: ' + today,
    '  source: baton',
    '---',
    '',
    a.body.trim(),
    '',
  ].join('\n')
}

export const indexLine = (a) => '- [' + a.title + '](' + a.name + '.md) — ' + a.description

// 講了 PROMOTE_COUNT 次以上、還沒放進專案（也沒被拒絕）的 feedback
export const promoteCandidates = (memories) =>
  memories.filter((m) => m.type === 'feedback' && (Number(m.count) || 1) >= PROMOTE_COUNT && !m.promoted).slice(0, PROMOTE_ITEMS)
