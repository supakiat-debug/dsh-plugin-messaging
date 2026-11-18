// chunk.js — split a reply into <= maxChunks messages, each <= budget chars.
// Counts UTF-16 code units via String.length, which matches how LINE (5000),
// Telegram (4096), WhatsApp (4096), Discord (2000) and Messenger (2000) count
// message length.
//
// Unlike the Discord bridge there is NO code-fence re-opening logic: LINE, Messenger
// and WhatsApp render no markdown, Telegram uses HTML/MarkdownV2 and Discord's fence
// blocks survive a split badly, so re-opening fences across chunks is unnecessary and
// would leak literal backticks.

export const HARD_LIMITS = { line: 5000, telegram: 4096, whatsapp: 4096, discord: 2000, messenger: 2000 }

/**
 * @param {string} text raw reply text
 * @param {number} budget preferred max chars per message
 * @param {number} maxChunks hard cap on number of messages (user asked "2 or 3")
 * @param {number} hardLimit absolute per-message limit for the platform
 * @param {string} notice suffix appended when text overflows maxChunks (translated by the caller)
 * @returns {string[]} chunks (possibly fewer than maxChunks)
 */
export function chunkReply(text, budget = 1800, maxChunks = 3, hardLimit = 5000, notice = '…(truncated)') {
  const t = (text ?? '').trim()
  if (!t) return []
  const cap = Math.min(Math.max(1, Math.floor(budget) || 1), hardLimit)
  const chunks = Math.max(1, Math.floor(maxChunks) || 1)
  const out = []
  let rest = t
  while (rest && out.length < chunks) {
    const cut = cutIndex(rest, cap)
    out.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).replace(/^\s+/, '')
  }
  if (rest) {
    // Overflow beyond maxChunks: append a truncation notice, reserving room so
    // the last chunk still respects the per-message budget.
    if (out.length) {
      const keep = Math.max(0, cap - notice.length - 1)
      out[out.length - 1] = out[out.length - 1].slice(0, keep).trimEnd() + notice
    } else {
      out.push(notice)
    }
  }
  return out.filter(Boolean)
}

/** Choose a cut point <= cap, preferring paragraph > newline > space > hard cut. */
function cutIndex(s, cap) {
  if (s.length <= cap) return s.length
  const win = s.slice(0, cap)
  const para = win.lastIndexOf('\n\n')
  if (para > cap * 0.5) return para + 2
  const nl = win.lastIndexOf('\n')
  if (nl > cap * 0.5) return nl + 1
  const sp = win.lastIndexOf(' ')
  if (sp > cap * 0.5) return sp + 1
  return cap
}
