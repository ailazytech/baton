// 防呆提醒、整理筆記、守門的判斷邏輯（純函式）
import { expect, test } from 'claude-code/testing'
import { claimsDone, doneCheck, failureSignature, freshWork, isCheckCommand, judge, noteCall, replyLangOfSetting, trackFailure } from '../hooks/nudges.js'
import { parseActions, setMeta } from '../hooks/notes.js'
import { guardCandidates, parseGuards } from '../hooks/guards.js'

// ---------- 防呆提醒 ----------

test('失敗簽名：路徑、數字、空白不同但原因相同的錯誤視為同一個', () => {
  const a = failureSignature('Error: ENOENT  C:\\work\\a\\x.ts line 12\n  at foo (/srv/a/b.js:3:4)')
  const b = failureSignature('Error: ENOENT /Users/user/other/y.ts line 99 at foo (/tmp/c.js:7:8)')
  expect(a).toBe(b)
  expect(failureSignature('Error: A')).not.toBe(failureSignature('Error: B'))
})

test('連續失敗：第 2 次相同簽名才回 true、每段只一次、成功與使用者中斷重新算', () => {
  const m = new Map()
  const call = (isError: boolean, text?: string) => trackFailure(m, 'Bash', isError, text)
  expect(call(true, 'boom 1')).toBe(false)
  expect(call(true, 'boom 2')).toBe(true)
  expect(call(true, 'boom 3')).toBe(false)
  expect(call(false)).toBe(false)
  expect(call(true, "The user doesn't want to proceed with this tool use")).toBe(false)
  expect(call(true, "The user doesn't want to proceed with this tool use")).toBe(false)
})

test('驗證指令：測試、檢查、建置算；只是看檔案的不算', () => {
  for (const c of ['npm test', 'claude plugin test', 'go test ./...', 'npm run build', 'cargo clippy', 'cd x && npx tsc -p .'])
    expect(isCheckCommand(c)).toBe(true)
  for (const c of ['ls tests/', 'cat test.js', 'git commit -m "add tests"', 'grep -rn check src', 'echo done', ''])
    expect(isCheckCommand(c)).toBe(false)
})

test('完成的說法：否定、提問、已說明沒驗證或測試失敗的不算', () => {
  for (const m of ['已經改好了，完成了。', '都好了', '修好了', 'All done.', "I've fixed it"])
    expect(claimsDone(m)).toBe(true)
  for (const m of ['還沒完成，我再看看', '要我完成嗎？', 'Is it done?', '完成了，但我沒有跑測試', '已經改好了，但測試失敗', 'Done, though I could not run the tests', ''])
    expect(claimsDone(m)).toBe(false)
})

test('doneCheck：改檔沒驗證回 unverified、檢查沒過回 failed、只改文件不算', () => {
  const w = freshWork()
  noteCall(w, 'Edit', { file_path: 'a.ts' }, false)
  expect(doneCheck(w, '完成了', false)).toBe('unverified')
  const w2 = freshWork()
  noteCall(w2, 'Edit', { file_path: 'a.ts' }, false)
  noteCall(w2, 'Bash', { command: 'npm test' }, true)
  expect(doneCheck(w2, '完成了', false)).toBe('failed')
  const w3 = freshWork()
  noteCall(w3, 'Edit', { file_path: 'README.md' }, false)
  expect(doneCheck(w3, '完成了', false)).toBeUndefined()
})

test('language 設定對應回覆語言', () => {
  expect(replyLangOfSetting('繁體中文台灣用語')).toBe('zh-TW')
  expect(replyLangOfSetting('English')).toBe('en')
  expect(replyLangOfSetting('日本語')).toBe('ja')
  expect(replyLangOfSetting('中文')).toBeUndefined()
})

test('語言判斷：簡體字混多了算跑掉，短句不判斷', () => {
  expect(judge('这个问题我们已经处理过了，现在的设计会让每个请求都经过验证，没有问题的话就继续进行下一步的开发和测试工作，请确认。', 'zh-TW')).toBe('off')
  expect(judge('好', 'zh-TW')).toBe('short')
})

// ---------- 整理筆記 ----------

test('setMeta：有就改、沒有就加在 metadata 底下，內文不動', () => {
  const raw = '---\nname: a\nmetadata:\n  type: feedback\n  count: 2\n---\n\n內文\n'
  expect(setMeta(raw, { count: 3, last_seen: '2026-10-19' })).toBe('---\nname: a\nmetadata:\n  type: feedback\n  count: 3\n  last_seen: 2026-10-19\n---\n\n內文\n')
  expect(setMeta('---\nname: b\n---\n\nx\n', { count: 2 })).toBe('---\nname: b\nmetadata:\n  count: 2\n---\n\nx\n')
  // Windows 存的 CRLF 也認得
  expect(setMeta('---\r\nname: c\r\nmetadata:\r\n  type: user\r\n---\r\n\r\ny\r\n', { count: 2 })).toContain('  type: user\n  count: 2\n---')
})

test('parseActions：原話要對得上、add 撞名改成 confirm、像金鑰的丟掉', () => {
  const text = [
    '<<<ACTIONS',
    '{"op":"add","name":"keep-short","title":"短","type":"feedback","layer":"user","description":"回覆短","body":"短","quote":"回覆短一點"}',
    '{"op":"add","name":"old-one","title":"舊","type":"feedback","description":"d","body":"b","quote":"回覆短一點"}',
    '{"op":"add","name":"secret","title":"s","type":"feedback","description":"d","body":"token: abcdefgh1234","quote":"回覆短一點"}',
    '{"op":"confirm","name":"nope","quote":"回覆短一點"}',
    'ACTIONS>>>',
  ].join('\n')
  const r = parseActions(text, new Set(['old-one']), ['好，回覆短一點'])
  expect(r.adds.map((a: any) => a.name)).toEqual(['keep-short'])
  expect(r.adds[0].layer).toBe('user')
  expect(r.confirms.map((c: any) => c.name)).toEqual(['old-one'])
  expect(r.rejected.length).toBe(2)
})

// ---------- 守門 ----------

test('parseGuards：違規範例要被擋、正確範例要放行、只收候選規則', () => {
  const text = [
    '<<<GUARDS',
    '{"rule":"a","tool":"Bash","match":"git\\\\s+push","mode":"deny","message":"m","bad":"git push","good":"git status"}',
    '{"rule":"b","tool":"Bash","match":".*","mode":"remind","message":"m","bad":"x","good":"y"}',
    '{"rule":"zzz","tool":"Bash","match":"x","mode":"remind","message":"m","bad":"x","good":"y"}',
    'GUARDS>>>',
  ].join('\n')
  const r = parseGuards(text, new Set(['a', 'b']))
  expect(r.out.map((g: any) => g.rule)).toEqual(['a'])
  expect(r.rejected.length).toBe(2)
})

test('guardCandidates：放進專案後次數又變多、或拒絕放進專案但講了 3 次', () => {
  const m = (over: object) => ({ name: 'n', type: 'feedback', count: 3, promoted: '', promotedCount: 0, ...over })
  const list = [
    m({ name: 'again', promoted: 'AGENTS.md', count: 4, promotedCount: 3 }),
    m({ name: 'same', promoted: 'AGENTS.md', count: 3, promotedCount: 3 }),
    m({ name: 'declined', promoted: 'declined', count: 3 }),
    m({ name: 'fresh', count: 5 }),
    m({ name: 'has-guard', promoted: 'declined', count: 9 }),
  ]
  expect(guardCandidates(list, [{ rule: 'has-guard' }]).map((x: any) => x.name)).toEqual(['again', 'declined'])
})
