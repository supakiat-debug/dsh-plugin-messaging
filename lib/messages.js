// messages.js — the bridge's OWN user-facing strings (never AI replies).
//
// Policy: the AI's answer is sent verbatim and is NEVER translated. Only these
// short, fixed bridge messages (status, errors, "no answer", max-token/length,
// command replies, truncation notice) are translated into the reply language.
// Base language is English; the translator caches every string on disk, so a
// given phrase is fetched at most once per target language.
//
// Dynamic reports (count / status) translate only their static LABELS and
// assemble numbers/ids in code — that keeps the cache warm (the surrounding
// digits would otherwise make every report a cache miss).

export const MESSAGES = {
  thinking: '🤖 Thinking…',
  noAnswer: '(no answer)',
  cancelled: '⚠️ Message did not reach the session (it may have been cancelled). Please try again.',
  endedUnknown: '(ended without a result: {kind})',
  error: '⚠️ {msg}',
  internalError: '⚠️ Internal error: {msg}',
  truncated: '…(truncated)',
  unknownCommand: 'Unknown command /{name} — type /help',
  newSession: '🆕 New session started — just type (a new session is created when you ask).',
  currentNone: 'No session yet (type a message to start one).',
  stopped: '⏹ Generation stopped.',
  langUsage: 'Choose a reply language: {list}\nExample: /lang th',
  quota: "ℹ️ Quota depends on the platform — use /count for this month's message totals (on LINE, push messages are metered).",
  useUsage: 'Usage: /use <sessionId>',
  help: '💬 Commands:\n{lines}',
}

// Static labels used to assemble dynamic reports (numbers/ids stay untranslated).
export const LABELS = {
  replyLang: 'Reply language',
  session: 'session',
  bound: 'bound session',
  boundSessions: 'Bound sessions',
  noBound: 'No bound sessions yet',
  month: 'Month',
  inbound: 'Inbound',
  outbound: 'Outbound',
  realMessages: 'real messages',
  pushMetered: 'push (metered)',
  replyFree: 'reply (free)',
  translated: 'translated',
  status: 'Status',
  language: 'language',
  platform: 'platform',
  thisMonth: 'this month',
  recv: 'recv',
  sent: 'sent',
  noSession: 'no session',
}

// Help lines (English base; the leading /command tokens survive translation).
export const HELP_LINES = [
  '/new [title] — start a new session',
  '/sessions — list recent bound sessions',
  '/use <id|name> — switch session',
  '/current — current session',
  '/stop — stop the running generation',
  '/lang en|zh|th — change reply language',
  '/status — AI status (session, t/s)',
  '/count — message totals this month',
  '/quota — platform quota (if any)',
  '/help — this menu',
]

function interpolate(template, params) {
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (_, k) => (params[k] !== undefined ? String(params[k]) : `{${k}}`))
}

/**
 * Translate a static bridge message (English base) into `lang`.
 * `lang === 'en'` short-circuits (no network). Errors pass the base through.
 */
export async function sysText(translator, lang, key, params) {
  const base = interpolate(MESSAGES[key] ?? key, params)
  if (!translator || lang === 'en') return base
  try { return await translator.translate(base, lang) } catch { return base }
}

/** Translate a set of static labels into `lang`; resolves to { key: text }. */
export async function labels(translator, lang, keys) {
  const out = {}
  if (!translator || lang === 'en') {
    for (const k of keys) out[k] = LABELS[k] ?? k
    return out
  }
  await Promise.all(keys.map(async (k) => {
    const base = LABELS[k] ?? k
    try { out[k] = await translator.translate(base, lang) } catch { out[k] = base }
  }))
  return out
}
