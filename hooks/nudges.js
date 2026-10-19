// 防呆提醒的判斷邏輯（不碰 $、不放介面文字）：同樣的失敗連續兩次、說完成了卻沒驗證、回覆語言跑掉。
// 移植自 ctx-handoff-mod（MIT，Copyright (c) 2026 cablate）的 hooks/loops.ts 與 hooks/lang.ts。
// 給 Claude 的提醒文字在 register.js 的 I18N；唯一的例外是回覆語言提醒：它要用「目標語言」寫（不是介面語言），所以留在這裡

// ---------- 同一個工具連續兩次因同樣原因失敗 ----------

const MAX_SIG = 200
const MAX_STREAKS = 200
// 終端機顏色碼（用建構式寫，避免控制字元直接出現在樣式裡）
const ANSI = new RegExp(String.raw`${String.fromCharCode(27)}\[[0-9;]*[A-Za-z]`, 'g')
// 使用者自己中斷或拒絕的不是「工具失敗」，不提醒
const USER_STOP = /doesn't want to proceed|user rejected|interrupted by user|request interrupted|user denied/i

// 錯誤文字的簽名：去掉顏色碼、路徑、數字（行號、時間、id）與空白差異，取前 200 字
export function failureSignature(text) {
  return String(text ?? '')
    .replace(ANSI, '')
    .replace(/[A-Za-z]:[\\/][^\s'"`)>\]]*/g, '<p>')
    .replace(/(?:\.{0,2}\/)?(?:[\w.@~-]+\/)+[\w.@~-]*/g, '<p>')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_SIG)
}

// 給模型看的簡短錯誤：第一個非空行，最多 80 字
export function briefOf(text) {
  const line =
    String(text ?? '')
      .split('\n')
      .map((l) => l.trim())
      .find(Boolean) ?? ''
  return line.length > 80 ? line.slice(0, 80) + '…' : line
}

// 記下一次工具結果；第 2 次相同簽名的失敗回傳 true（每段連續失敗只回一次）。
// streaks：Map，key 是呼叫的範圍＋工具名；成功就清掉這個工具的紀錄
export function trackFailure(streaks, key, isError, text) {
  if (!isError || USER_STOP.test(String(text ?? ''))) {
    streaks.delete(key)
    return false
  }
  const sig = failureSignature(text)
  const prev = streaks.get(key)
  if (!prev || prev.sig !== sig) {
    // 簽名換了就是新的一段；上限只防無限長大
    if (!prev && streaks.size >= MAX_STREAKS) streaks.clear()
    streaks.set(key, { sig, count: 1, nudged: false })
    return false
  }
  prev.count += 1
  if (prev.count < 2 || prev.nudged) return false
  prev.nudged = true
  return true
}

// ---------- 說完成了，但改檔之後沒有任何驗證 ----------

// 這一輪的工作紀錄：seq 是已完成的工具呼叫序號；lastEdit／lastCheck 是最後一次改檔／驗證通過的序號（0＝沒有）
export function freshWork() {
  return { seq: 0, lastEdit: 0, lastCheck: 0, checkFailed: false, reminded: false }
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
// 說明文件與暫存檔的修改不需要跑專案測試
const DOC_FILE = /\.(md|mdx|txt|rst|adoc)$/i
const SCRATCH_PATH = /(?:^|[\\/])(?:scratchpad|\.review)[\\/]/i
// 這些指令只是看或搬東西，不算驗證
const NOT_RUNNING = new Set(['ls', 'cat', 'echo', 'grep', 'rg', 'find', 'head', 'tail', 'git', 'cd', 'mkdir', 'rm', 'cp', 'mv', 'sed', 'awk', 'type', 'wc', 'diff', 'open', 'pwd', 'which', 'printf'])
const CHECK_WORDS = /\b(tests?|pytest|unittest|jest|vitest|mocha|rspec|phpunit|tsc|typecheck|lint|eslint|biome|oxlint|ruff|mypy|pyright|flake8|clippy|check|build|compile|verify|validate|vet)\b/i

// 這個 Bash／PowerShell 指令看起來是在跑測試、檢查或建置（任何一段指令符合就算）
export function isCheckCommand(command) {
  return String(command ?? '')
    .split(/&&|\|\||;|\||\n/)
    .some((seg) => {
      const words = seg.trim().split(/\s+/)
      const first = (words[0] ?? '').replace(/^.*[\\/]/, '').toLowerCase()
      return first !== '' && !NOT_RUNNING.has(first) && CHECK_WORDS.test(seg)
    })
}

// 記下一個已經執行完的工具呼叫。failed：工具回報錯誤（改檔失敗不算改檔；測試跑失敗記 checkFailed）
export function noteCall(work, tool, input, failed) {
  work.seq += 1
  if (EDIT_TOOLS.has(tool)) {
    if (failed) return
    const file = [input.file_path, input.notebook_path, input.path].find((p) => typeof p === 'string')
    if (file && (DOC_FILE.test(file) || SCRATCH_PATH.test(file))) return
    work.lastEdit = work.seq
    work.checkFailed = false
  } else if ((tool === 'Bash' || tool === 'PowerShell') && typeof input.command === 'string' && isCheckCommand(input.command)) {
    if (failed) {
      work.checkFailed = true
    } else {
      work.lastCheck = work.seq
      work.checkFailed = false
    }
  }
}

// 「完成了」的說法：只看開頭與結尾，排除否定（未／沒／不／尚）與提問
const CLAIM =
  /(?<![未沒不尚])(完成了|已完成|已經完成|做好了|改好了|都好了|已修好|修好了|已經修好|搞定了?|全部完成|都處理好了)|\b(all done|all set|i(?:'ve| have) (?:finished|completed|fixed)|(?:is|are|now|it's) (?:done|fixed|complete(?:d)?|finished)|fixed it|everything (?:is )?(?:done|working|fixed))\b/i
// 已經誠實說明沒驗證或測試失敗的，不再提醒
const HONEST =
  /沒有?(?:跑|執行|做)?(?:驗證|測試|檢查)|未(?:經)?(?:驗證|測試)|無法(?:驗證|測試)|沒辦法(?:驗證|測試)|(?:測試|驗證|檢查|編譯)(?:失敗|未通過|未過|沒過)|not (?:been )?(?:tested|verified)|couldn't (?:run|verify|test)|could not (?:run|verify|test)|unable to (?:run|verify|test)|haven't (?:run|tested|verified)|(?:tests?|checks?|build) failed/i

export function claimsDone(message) {
  const text = String(message ?? '').trim()
  if (!text || /[?？]$/.test(text)) return false
  const ends = text.length <= 600 ? text : text.slice(0, 200) + '\n' + text.slice(-400)
  return CLAIM.test(ends) && !HONEST.test(ends)
}

// 回合結束時要不要擋下停止：回傳 'failed'（改檔後的檢查沒過）、'unverified'（改檔後沒跑檢查）或 undefined。
// 每個回合最多一次；stopHookActive＝這次停止已經被別的 hook 擋過一次
export function doneCheck(work, message, stopHookActive) {
  if (work.reminded || stopHookActive) return undefined
  if (work.lastEdit === 0 || (work.lastCheck > work.lastEdit && !work.checkFailed)) return undefined
  if (!claimsDone(message)) return undefined
  work.reminded = true
  return work.checkFailed ? 'failed' : 'unverified'
}

// ---------- 回覆語言 ----------
// 判斷只看「說明文字」：先去掉程式碼、網址、路徑、指令等，再數漢字、假名、韓文與英文單字。
// 寧可漏提醒也不要誤提醒：夾英文術語的中文、很短的句子、程式碼與專有名詞都不該觸發

const TW = /繁體|繁体|traditional|zh[-_ ]?(?:tw|hk|hant)|台灣|臺灣|taiwan/i
const CN = /简体|簡體|简體|simplified|zh[-_ ]?(?:cn|hans|sg)|大陆|大陸|mainland/i
const JA = /^ja\b|japanese|日本語|日本语|日语|日語|nihongo/i
const EN = /^en\b|english|英語|英语|英文/i

// Claude Code 的 language 設定（自由文字）對應到目標語言；分不出來回 undefined（不提醒）
export function replyLangOfSetting(setting) {
  if (typeof setting !== 'string') return undefined
  const s = setting.trim()
  if (!s) return undefined
  if (TW.test(s)) return 'zh-TW'
  if (CN.test(s)) return 'zh-CN'
  if (JA.test(s)) return 'ja'
  if (EN.test(s)) return 'en'
  return undefined
}

// 一對一排好的「簡體字 繁體字」，只放簡體字不會出現在一般臺灣繁體文章裡的字
const PAIRS = [
  '这這', '们們', '说說', '时時', '会會', '为為', '对對', '发發', '经經', '过過', '还還', '进進', '没沒', '问問', '么麼', '样樣',
  '现現', '应應', '该該', '与與', '个個', '从從', '动動', '见見', '长長', '开開', '关關', '题題', '设設', '计計', '数數', '据據',
  '记記', '录錄', '处處', '验驗', '证證', '测測', '试試', '输輸', '错錯', '误誤', '实實', '际際', '项項', '档檔', '读讀', '写寫',
  '请請', '让讓', '给給', '变變', '将將', '节節', '点點', '单單', '简簡', '体體', '语語', '较較', '线線', '网網', '页頁', '务務',
  '产產', '业業', '东東', '门門', '间間', '机機', '软軟', '执執', '码碼', '类類', '调調', '结結', '构構', '创創', '删刪', '导導',
  '库庫', '态態', '状狀', '况況', '总總', '无無', '当當', '电電', '脑腦', '视視', '觉覺', '学學', '习習', '师師', '员員', '报報',
  '认認', '识識', '别別', '选選', '择擇', '参參', '协協', '议議', '储儲', '缓緩', '区區', '块塊', '边邊', '缘緣', '压壓', '缩縮',
  '传傳', '递遞', '载載', '术術', '编編', '译譯', '运運', '环環', '权權', '级級', '备備', '启啟', '终終', '显顯', '图圖', '标標',
  '击擊', '键鍵', '盘盤', '针針', '抛拋', '释釋', '虑慮', '担擔', '响響', '优優', '续續', '继繼', '断斷', '联聯', '络絡', '链鏈',
  '层層', '览覽', '话話', '讨討', '论論', '难難', '确確', '吗嗎', '谢謝', '帮幫', '买買', '卖賣', '钱錢', '费費', '购購', '账帳',
  '号號', '钥鑰', '书書', '条條', '规規', '则則', '围圍', '举舉', '两兩', '闻聞', '阅閱', '队隊', '阶階', '随隨', '义義', '乱亂',
  '头頭', '兴興', '亲親', '仅僅', '仓倉', '众眾', '伤傷', '侧側', '养養', '军軍', '农農', '减減', '刚剛', '剧劇', '办辦', '劳勞',
  '势勢', '双雙',
]
const SIMPLIFIED_ONLY = new Set(PAIRS.map((p) => p[0]))
const TRADITIONAL_ONLY = new Set(PAIRS.map((p) => p[1]))

// 太短的不判斷：漢字／假名／韓文少於 40 個、而且英文單字少於 16 個
const MIN_CJK = 40
const MIN_LATIN = 16
// 某種文字占「單位」的比例超過這個才算主導。單位：英文 1 個單字、日韓中文 2 個字
const DOMINANT = 0.6
// 簡繁專用字至少 3 個、占漢字超過 6%，才算寫成另一種字形
const MIX_MIN = 3
const MIX_SHARE = 0.06
const MAX_TEXT = 20000

// 去掉不算「說明」的部分：圍欄程式碼、引用行、行內程式碼、網址、路徑、@提及、斜線指令、檔名與 a.b 形式的識別字
export function proseOf(text) {
  const kept = []
  let fence
  for (const line of text.split('\n')) {
    const head = line.trimStart()
    const mark = head.startsWith('```') ? '```' : head.startsWith('~~~') ? '~~~' : undefined
    if (fence !== undefined) {
      if (mark === fence) fence = undefined
      continue
    }
    if (mark !== undefined) {
      fence = mark
      continue
    }
    if (head.startsWith('>')) continue
    kept.push(line)
  }
  return kept
    .join('\n')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, ' ')
    .replace(/\bwww\.\S+/gi, ' ')
    .replace(/\b[A-Za-z]:[\\/][^\s"'`)\]>]*/g, ' ')
    .replace(/(?:\.{1,2}\/|~\/|\/)?(?:[\w.@~-]+\/)+[\w.@~-]*/g, ' ')
    .replace(/(?<!\w)@[\w./-]+/g, ' ')
    .replace(/(?<![\w/])\/[A-Za-z][\w:-]*/g, ' ')
    .replace(/\b[\w-]+(?:\.[\w-]+)+\b/g, ' ')
}

// 英文單字：2 個字母以上、全小寫或只有開頭大寫。全大寫縮寫、駝峰、底線與夾數字的識別字都不算
const WORD = /^[A-Z]?[a-z]{2,}$/
const HAN_RE = /\p{Script=Han}/u
const KANA_RE = /[\p{Script=Hiragana}\p{Script=Katakana}]/u
const HANGUL_RE = /\p{Script=Hangul}/u

function countOf(prose) {
  const c = { han: 0, kana: 0, hangul: 0, latin: 0, simp: 0, trad: 0 }
  for (const ch of prose) {
    if (ch <= '\u007f') continue
    if (HAN_RE.test(ch)) {
      c.han += 1
      if (SIMPLIFIED_ONLY.has(ch)) c.simp += 1
      else if (TRADITIONAL_ONLY.has(ch)) c.trad += 1
    } else if (KANA_RE.test(ch)) c.kana += 1
    else if (HANGUL_RE.test(ch)) c.hangul += 1
  }
  for (const w of prose.match(/[A-Za-z0-9_]+(?:'[A-Za-z]+)?/g) ?? []) if (WORD.test(w.replace(/'[A-Za-z]+$/, ''))) c.latin += 1
  return c
}

// 'on'：是目標語言；'off'：不是；'short'：太短不判斷
export function judge(text, target) {
  const c = countOf(proseOf(String(text).slice(0, MAX_TEXT)))
  const cjk = c.han + c.kana + c.hangul
  if (cjk < MIN_CJK && c.latin < MIN_LATIN) return 'short'
  const total = cjk / 2 + c.latin
  const latinShare = total > 0 ? c.latin / total : 0
  const mixed = (n) => n >= MIX_MIN && c.han > 0 && n / c.han > MIX_SHARE
  switch (target) {
    case 'en':
      return 1 - latinShare > DOMINANT ? 'off' : 'on'
    case 'ja':
      if (latinShare > DOMINANT) return 'off'
      if (c.hangul > c.han + c.kana) return 'off'
      // 日文一定有大量假名；有漢字卻幾乎沒有假名，是中文
      return c.han >= 30 && c.kana / (c.han + c.kana) < 0.1 ? 'off' : 'on'
    case 'zh-TW':
      if (latinShare > DOMINANT) return 'off'
      if (c.kana >= 10 && c.kana > c.han * 0.2) return 'off'
      return mixed(c.simp) ? 'off' : 'on'
    case 'zh-CN':
      if (latinShare > DOMINANT) return 'off'
      if (c.kana >= 10 && c.kana > c.han * 0.2) return 'off'
      return mixed(c.trad) ? 'off' : 'on'
  }
  return 'short'
}

// 用目標語言寫的提醒（模型讀起來自然）；程式碼、指令、路徑與專有名詞維持原文
export function langReminderText(target) {
  switch (target) {
    case 'zh-TW':
      return '[baton] 你剛才那段說明不是繁體中文。之後的說明請用繁體中文（程式碼、指令、路徑與專有名詞維持原文）。使用者要你寫的其他語言內容（翻譯、英文文件等）照原本的要求寫。'
    case 'zh-CN':
      return '[baton] 你刚才那段说明不是简体中文。之后的说明请用简体中文（代码、命令、路径和专有名词保持原文）。用户要你写的其他语言内容（翻译、英文文档等）照原本的要求写。'
    case 'en':
      return '[baton] Your last explanation was not in English. Please write explanations in English from now on (keep code, commands, paths and proper nouns as they are). Content the user asked for in another language, such as a translation, stays as requested.'
    case 'ja':
      return '[baton] 先ほどの説明は日本語ではありませんでした。以降の説明は日本語で書いてください（コード、コマンド、パス、固有名詞は原文のままで構いません）。ユーザーが別の言語で頼んだ内容（翻訳、英語の文書など）はそのままで構いません。'
  }
  return ''
}

// 提醒的進度：nudged＝這一段已經提醒過；pending＝等主對話下一個工具結果帶出去；next＝等使用者的下一則訊息帶出去
export function freshReply() {
  return { nudged: false, pending: undefined, next: undefined }
}

// 記下主對話一個步驟的回覆。不是目標語言就排一次提醒（每段只提醒一次，之後有一步符合目標語言才重算）
export function noteStep(state, answer, hasToolUses, target) {
  const verdict = judge(answer, target)
  if (verdict === 'on') state.nudged = false
  if (verdict !== 'off' || state.nudged) return
  state.nudged = true
  if (hasToolUses) state.pending = langReminderText(target)
  else state.next = langReminderText(target)
}

// 工具結果要附的提醒（附了就清掉）
export function takePending(state) {
  const text = state.pending
  state.pending = undefined
  return text
}

// 使用者的下一則訊息要附的提醒（附了就清掉）；上一輪沒附出去的 pending 也一併帶上
export function takeNext(state) {
  const out = [...new Set([state.pending, state.next].filter((s) => s !== undefined))]
  state.pending = undefined
  state.next = undefined
  return out
}
