// adapters/telegram.js — Telegram Bot API adapter (long polling by default).
// Long-poll needs NO public URL (works behind NAT), which is why Telegram is the
// recommended first platform. It is also the only platform here that supports
// editMessageText, giving us a live "AI working status" (thinking… -> t/s).
//
// Two rules learned the hard way, both of which used to drop replies entirely:
//  1. parse_mode=HTML accepts only a small tag whitelist. The bridge sends the AI
//     answer VERBATIM, so a literal `<token>` / `<div>` / `<sdk/>` in the text was a
//     hard 400 ("can't parse entities: Unsupported start tag") on the status edit,
//     on the fallback send, and on every chunk => nothing arrived. All outbound text
//     is now HTML-escaped, and any residual entity error retries once as plain text.
//  2. editMessageText is limited to ~1/s per message and ~20/min in a group. The
//     live-status timer must throttle, skip no-op edits and stop on 429 — while the
//     FINAL replace waits out retry_after, because delivering late beats dropping.

const API = (token, method) => `https://api.telegram.org/bot${token}/${method}`
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const TEXT_LIMIT = 4096          // Telegram's per-message hard limit
const STATUS_EDIT_MIN_MS = 4000  // minimum spacing between live-status edits

// Telegram HTMLV1 only needs these three escaped; everything else stays literal text.
const escapeHtml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const isEntityError = (d) => /can't parse entities|unsupported start tag|unsupported end tag|can't find end tag|unmatched|unexpected end/i.test(d || '')
const isRateLimit = (d) => /too many|retry after|429/i.test(d || '')

const COMMANDS = [
  { command: 'new', description: 'session ใหม่' },
  { command: 'sessions', description: 'รายการ session' },
  { command: 'use', description: 'สลับ session' },
  { command: 'current', description: 'session ปัจจุบัน' },
  { command: 'stop', description: 'หยุด generation' },
  { command: 'lang', description: 'ภาษาตอบกลับ en/zh/th' },
  { command: 'status', description: 'สถานะ AI' },
  { command: 'count', description: 'จำนวน message เดือนนี้' },
  { command: 'help', description: 'ช่วยเหลือ' },
]

export function createTelegramAdapter(cfg, { bridge, log = () => {} }) {
  const t = cfg.telegram
  const token = t.botToken || process.env[t.botTokenEnv] || ''
  const allowedUsers = new Set((t.allowedUserIds || []).map(String))
  // Usernames (non-numeric entries, @-optional, case-insensitive) so a config can
  // list "@SuperKTH" instead of hunting for the numeric id. Numeric ids still work.
  const allowedUserNames = new Set(
    (t.allowedUserIds || [])
      .map((u) => String(u).replace(/^@/, '').trim().toLowerCase())
      .filter((u) => u && !/^\d+$/.test(u)),
  )
  // Telegram group/channel ids are negative (e.g. -1003478007355); users often paste the
  // positive form. Compare sign-insensitively so either spelling matches the real id.
  const normChat = (v) => String(v).replace(/^-/, '')
  const allowedChats = new Set((t.allowedChatIds || []).map(normChat))
  let offset = 0
  let running = false

  /**
   * One Bot API call. Retries once on 429 honouring `parameters.retry_after`
   * (capped), and never throws — callers get `{ ok:false, description }`.
   * `retries: 0` is used by the live-status timer, which must fail fast so the
   * bridge can pause instead of queueing edits behind a 20s cooldown.
   */
  async function call(method, body, { retries = 1, quiet = false } = {}) {
    for (let attempt = 0; ; attempt++) {
      let data
      try {
        const res = await fetch(API(token, method), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(30000),
        })
        data = await res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` }))
      } catch (e) {
        if (!quiet) log(`telegram ${method} err: ${e?.message || e}`)
        return { ok: false, description: e?.message || String(e) }
      }
      if (data.ok) return data
      const description = data.description || ''
      const wait = Number(data?.parameters?.retry_after) || (isRateLimit(description) ? 5 : 0)
      if (wait && attempt < retries) { await sleep(Math.min(wait * 1000 + 250, 30000)); continue }
      if (!quiet) log(`telegram ${method}: ${description || 'failed'}`)
      return { ...data, ok: false, description }
    }
  }

  // Split the RAW text into pieces whose ESCAPED form still fits 4096 — escaping
  // inflates `&`→5 and `<`/`>`→4 chars, so the raw cut point is not the escaped one.
  // Splitting raw (never escaped) text is also what lets the plain-text fallback
  // below send the original characters instead of literal `&lt;`.
  function splitRaw(text) {
    const s = String(text ?? '')
    if (escapeHtml(s).length <= TEXT_LIMIT) return [s]
    const out = []
    let start = 0, esc = 0
    for (let i = 0; i < s.length; i++) {
      const c = s[i]
      const w = c === '&' ? 5 : (c === '<' || c === '>') ? 4 : 1
      if (esc + w > TEXT_LIMIT) {
        out.push(s.slice(start, i)); start = i; esc = 0
      }
      esc += w
    }
    if (start < s.length) out.push(s.slice(start))
    return out.length ? out : [s]
  }

  /**
   * Send/edit one text payload. Always HTML-escaped; if Telegram still rejects the
   * entities for any reason, retry that piece as PLAIN text (no parse_mode) so a
   * formatting quirk can never swallow the answer. Returns { ok, messageId }.
   */
  async function postText(method, extra, text, opts = {}) {
    let first
    for (const piece of splitRaw(text)) {
      if (!piece) continue
      let res = await call(method, { ...extra, text: escapeHtml(piece), parse_mode: 'HTML' }, opts)
      if (!res.ok && isEntityError(res.description)) {
        // Last-resort: the RAW piece with no parse_mode, so nothing is ever lost to
        // entity parsing (and the user never sees literal `&lt;`).
        res = await call(method, { ...extra, text: piece }, opts)
        if (res.ok) log(`telegram ${method}: sent as plain text (HTML entities rejected)`)
      }
      if (!res.ok) return { ok: false, description: res.description }
      if (first === undefined && res.result?.message_id) first = res.result.message_id
    }
    return { ok: true, messageId: first }
  }

  function allowed(msg) {
    const from = String(msg.from?.id ?? '')
    const chat = String(msg.chat?.id ?? '')
    const uname = (msg.from?.username || '').replace(/^@/, '').toLowerCase()
    const isGroup = msg.chat?.type === 'group' || msg.chat?.type === 'supergroup'
    if (allowedUsers.size && !(allowedUsers.has(from) || (uname && allowedUserNames.has(uname)))) return false
    if (isGroup && allowedChats.size && !allowedChats.has(normChat(chat))) return false
    return true
  }

  function makeEv(msg) {
    const chatId = String(msg.chat.id)
    const isGroup = msg.chat?.type === 'group' || msg.chat?.type === 'supergroup'
    const text = (msg.text || '').replace(/\/(\w+)@\S+/g, '/$1') // strip @botname from commands

    const send = async (chunks) => {
      let first
      let sent = 0
      for (const c of chunks) {
        const r = await postText('sendMessage', { chat_id: chatId, disable_web_page_preview: true }, c)
        // postText() only returns ok:false after the plain-text fallback also failed,
        // so this is a real delivery failure: report how much reached the chat and stop,
        // rather than counting an answer nobody received.
        if (!r.ok) {
          const e = new Error(`telegram: sendMessage was not delivered — ${r.description || 'unknown error'}`)
          e.sent = sent
          throw e
        }
        sent++
        if (first === undefined && r.messageId) first = r.messageId
      }
      return { kind: 'push', messageId: first, sent }
    }
    const typing = () => call('sendChatAction', { chat_id: chatId, action: 'typing' }, { retries: 0, quiet: true })

    const startStatus = async (initial) => {
      const r = await postText('sendMessage', { chat_id: chatId }, initial)
      const mid = r.messageId
      let lastText = initial
      let lastEditAt = Date.now()
      let paused = false

      // Timer updates are best-effort: never throw, never block. Skips no-op edits
      // (Telegram 400 "message is not modified"), throttles to a group-safe rate, and
      // returns the raw result so the bridge can detect a 429 and clear its timer.
      const update = async (next) => {
        if (!mid || paused || next === lastText) return { ok: true, skipped: true }
        if (STATUS_EDIT_MIN_MS - (Date.now() - lastEditAt) > 0) return { ok: true, skipped: true }
        lastText = next
        lastEditAt = Date.now()
        const res = await call('editMessageText', { chat_id: chatId, message_id: mid, text: escapeHtml(next), parse_mode: 'HTML' }, { retries: 0, quiet: true })
        if (!res.ok && isRateLimit(res.description)) { paused = true; log('telegram: live status paused (rate limited)') }
        return res
      }
      // The final replace is load-bearing: wait out a 429 (call() honours retry_after)
      // and throw on failure so the bridge falls back to a normal send instead of
      // silently dropping the answer.
      const replace = async (next) => {
        if (!mid) throw new Error('no status message id to replace')
        const done = await postText('editMessageText', { chat_id: chatId, message_id: mid }, next)
        if (!done.ok) throw new Error(done.description || 'editMessageText failed')
      }
      return { update, replace, stop: async () => {} }
    }
    return {
      platform: 'telegram', chatId, userId: String(msg.from?.id ?? ''), text, isGroup,
      messageId: msg.message_id, send, typing,
      startStatus: t.editLiveStatus ? startStatus : undefined,
    }
  }

  async function poll() {
    let backoff = 1000
    while (running) {
      let data
      try {
        // Long-poll 25s + network slack. `connection: close` forces a fresh socket per
        // poll: Telegram half-closes the long-poll socket right after replying, and
        // undici reusing that dead keep-alive socket is what made the request hang until
        // the abort fired ("aborted due to timeout") — worst during long replies, when
        // polling is most frequent. A fresh socket removes the stall; the abort is now a
        // tighter safety net (25s long-poll + 15s slack) so a real blip recovers faster.
        const res = await fetch(`${API(token, 'getUpdates')}?timeout=25&offset=${offset}&allowed_updates=${encodeURIComponent(JSON.stringify(['message']))}`, {
          headers: { connection: 'close' },
          signal: AbortSignal.timeout(40000),
        })
        data = await res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` }))
      } catch (e) {
        // A dropped long-poll (proxy/DNS/keep-alive reset) is routine: back off and
        // keep going — the offset means no update is lost.
        log(`getUpdates err: ${e?.message || e} (retry in ${Math.round(backoff / 1000)}s)`)
        await sleep(backoff); backoff = Math.min(backoff * 2, 30000); continue
      }
      if (!data.ok) {
        const d = data.description || ''
        if (/conflict|terminated by new getUpdates/i.test(d)) {
          log('telegram: 409 conflict — another process is polling this bot token (or a webhook is set); stop the duplicate')
        } else log(`getUpdates failed: ${d || 'unknown'}`)
        await sleep(backoff); backoff = Math.min(backoff * 2, 30000); continue
      }
      backoff = 1000
      for (const upd of (data.result || [])) {
        offset = Math.max(offset, upd.update_id + 1)
        const msg = upd.message
        if (!msg?.text) continue
        if (!allowed(msg)) { log(`telegram: ignored message from user=${msg.from?.id ?? '?'} @${msg.from?.username ?? '?'} chat=${msg.chat?.id ?? '?'} (not allowlisted)`); continue }
        bridge.onInbound(makeEv(msg)) // fire-and-forget; bridge serializes per chat
      }
    }
  }

  return {
    name: 'telegram',
    configured: !!token,
    // Standalone push used by broadcast: send already-chunked text to an arbitrary
    // chat (no status/edit dance), reusing the same HTML-escape + plain fallback.
    send: async (chatId, chunks) => {
      for (const c of chunks) await postText('sendMessage', { chat_id: chatId, disable_web_page_preview: true }, c)
      return { kind: 'push' }
    },
    async start() {
      if (!token) { log('telegram: no bot token — adapter idle'); return }
      // A stale webhook makes getUpdates answer 409 Conflict, which looks like
      // "bot receives nothing" from the outside. Long-poll mode must clear it.
      if (t.receiveMode !== 'webhook') await call('deleteWebhook', {}, { retries: 0, quiet: true })
      try { await call('setMyCommands', { commands: COMMANDS }, { retries: 0, quiet: true }) } catch { /* ignore */ }
      running = true
      poll().catch(e => log('telegram poll died: ' + (e?.stack || e)))
      log('telegram: long-poll started')
    },
    async stop() { running = false },
  }
}
