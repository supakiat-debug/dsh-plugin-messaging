// adapters/messenger.js — Facebook Messenger (Meta Graph API) adapter, webhook only.
//
// Same Meta plumbing as the WhatsApp adapter — GET subscription handshake, an
// X-Hub-Signature-256 HMAC over the RAW body, Graph REST to send — but a different
// product: Messenger talks to a Facebook **Page**, the sender is a PSID (Page Scoped
// ID), and the payload lives in `entry[].messaging[]` instead of `entry[].changes[]`.
//
// What the platform enforces (see research note line-bridge-feasibility.md §13/§14 for
// the Meta comparison, which is why this adapter is webhook-only like WhatsApp):
//  • a PUBLIC HTTPS callback URL is required — front DSH with cloudflared / ngrok /
//    a reverse proxy and put that URL + the Verify token in App Dashboard → Messenger
//    → Webhooks (subscribe at minimum the `messages` field).
//  • the app needs the `pages_messaging` permission and a Page access token; the token
//    is what "we" are, so a Page role cannot be shared with another bridge at once.
//  • the **App Secret is mandatory**: it is the only thing that proves a callback came
//    from Meta, and the PSID in the body is whatever the caller types. `start()`
//    refuses to register the route without it — an open webhook is a login-as-anyone
//    endpoint in front of an AI with your tool access.
//  • 24-hour standard messaging window: inside it a reply is free-form; after that Meta
//    refuses the send (error #10 / subcode 551). We retry once with `messaging_type:
//    MESSAGE_TAG` when `outOfWindowTag` is configured (ACCOUNT_UPDATE, CONFIRMED_EVENT_
//    UPDATE, POST_PURCHASE_UPDATE or HUMAN_AGENT — HUMAN_AGENT is the one that reaches
//    people outside the window for a personal message).
//  • 2000 characters per message (chunk.js enforces it), no message editing → no live
//    "thinking…" status on this platform, only the typing bubble.
//  • `message.is_echo` carries the Page's OWN sends back to the webhook when the echo
//    callback is enabled — filtering it is what stops the bridge replying to itself.

import { createHmac, timingSafeEqual } from 'node:crypto'

const GRAPH_HOST = 'https://graph.facebook.com'
export const DEFAULT_GRAPH_VERSION = 'v24.0'

/** Meta refuses a reply once the 24h window has closed (error #10 / subcode 551). */
const WINDOW_ERROR = /#10\b|551|not delivered|24[- ]hour|messaging window|isn't available|activity ceiling/i

/**
 * Constant-time compare of the expected X-Hub-Signature-256 against the header.
 *
 * There is deliberately no "no secret = accept everything" branch. An unsigned
 * webhook is an open door, and this bridge's allowlist is built from sender ids the
 * caller invents, so anyone who learned the path could talk to the AI as you. The
 * adapter refuses to register the route at all without a secret (see start());
 * returning false here is the belt that keeps that door shut if it is ever reached.
 */
export function verifyMessengerSignature(appSecret, raw, header) {
  if (!appSecret) return false
  const expected = 'sha256=' + createHmac('sha256', appSecret).update(raw || '', 'utf8').digest('hex')
  try { return timingSafeEqual(Buffer.from(expected), Buffer.from(String(header || ''))) } catch { return false }
}

/**
 * Pull the text messages out of a webhook body.
 * Skips echoes, non-message events (read/delivery/postback), messages without text
 * (attachments — this bridge is text only) and senders off the allowlist.
 * @returns {{psid:string, text:string, mid:string, isGroup:boolean, pageId:string}[]}
 */
export function parseMessengerBody(body, { isAllowed = () => true } = {}) {
  const out = []
  for (const entry of (Array.isArray(body?.entry) ? body.entry : [])) {
    const pageId = String(entry?.id || '')
    for (const m of (Array.isArray(entry?.messaging) ? entry.messaging : [])) {
      const psid = String(m?.sender?.id || '')
      const msg = m?.message
      if (!psid || !msg || msg.is_echo) continue
      const text = typeof msg.text === 'string' ? msg.text : ''
      if (!text.trim()) continue
      if (!isAllowed(psid)) continue
      out.push({
        psid,
        text,
        mid: String(msg.mid || `${psid}:${m?.timestamp || ''}`),
        // Messenger group threads are addressed with thread tokens the Send API does not
        // accept here, so every reply is a Page-inbox DM: never claim it is a group.
        isGroup: false,
        pageId,
      })
    }
  }
  return out
}

/** True when Meta refused the send because the 24h window has closed. */
export function isMessengerWindowError(status, body) {
  if (status < 400) return false
  return WINDOW_ERROR.test(String(body || ''))
}

export function createMessengerAdapter(cfg, { bridge, log = () => {}, ctx }) {
  const m = cfg.messenger
  const token = m.pageAccessToken || process.env[m.pageAccessTokenEnv] || ''
  const appSecret = m.appSecret || process.env[m.appSecretEnv] || ''
  const version = m.graphVersion || DEFAULT_GRAPH_VERSION
  const allowedUsers = new Set((m.allowedUserIds || []).map(String))
  const seen = new Set()
  const webServer = ctx.get?.('webServer')
  let dispose

  const endpoint = () =>
    `${GRAPH_HOST}/${version}/${m.pageId || 'me'}/messages?access_token=${encodeURIComponent(token)}`

  async function post(payload) {
    const res = await fetch(endpoint(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const text = await res.text().catch(() => '')
    return { ok: res.ok, status: res.status, body: text }
  }

  /**
   * One text message. Inside the window Meta wants `messaging_type: RESPONSE`; outside
   * it the only thing that goes through is a permitted message tag.
   */
  async function sendText(psid, text, tag) {
    const payload = {
      recipient: { id: psid },
      messaging_type: tag ? 'MESSAGE_TAG' : 'RESPONSE',
      message: { text, ...(tag ? { metadata: 'dsh-messaging-bridge' } : {}) },
      ...(tag ? { tag } : {}),
    }
    const r = await post(payload)
    if (!r.ok && !tag && isMessengerWindowError(r.status, r.body)) {
      if (m.outOfWindowTag) {
        const retry = await post({ ...payload, messaging_type: 'MESSAGE_TAG', tag: m.outOfWindowTag, message: { ...payload.message, metadata: 'dsh-messaging-bridge' } })
        if (retry.ok) {
          // Worth saying out loud: the 24 h window is closed and every reply to this
          // user now rides on a message tag, which Meta audits per tag type.
          log(`messenger: 24h window closed for ${psid} — delivered as a tagged message (${m.outOfWindowTag})`)
          return { ok: true }
        }
        log(`messenger: window closed and tag ${m.outOfWindowTag} refused — ${r.status} ${r.body.slice(0, 200)}`)
        return retry
      }
      log(`messenger: 24h window closed for ${psid} — set messenger.outOfWindowTag (e.g. HUMAN_AGENT) or message the Page again. ${r.status} ${r.body.slice(0, 200)}`)
    } else if (!r.ok) {
      log('messenger send ' + r.status + ' ' + r.body.slice(0, 200))
    }
    return r
  }

  /** The typing bubble lasts ~25 s and cannot be edited away, so it is fire-and-forget. */
  function typingOn(psid) {
    if (m.typingIndicator === false) return
    post({ recipient: { id: psid }, sender_action: 'typing_on' }).catch(() => {})
  }

  /**
   * Send text chunk by chunk and report what Meta actually accepted.
   *
   * A Graph 503 is not a delivered message. Returning `{ kind: 'push' }` whatever
   * happened made the outbound counter look healthy while the user saw nothing, and any
   * retry would have re-sent the chunks that did arrive. So each accepted chunk counts,
   * and a refused one throws carrying the count of what got through: the bridge counts
   * exactly that, and the turn fails loudly instead of pretending to have landed.
   * @returns {Promise<number>} chunks delivered (only reached when all of them did)
   */
  async function sendChunks(psid, chunks) {
    let sent = 0
    for (const c of chunks) {
      const r = await sendText(psid, c)
      if (r?.ok) { sent++; continue }
      const e = new Error(`messenger: ${psid} did not receive the message — ${r?.status ?? 'no response'} ${String(r?.body || '').slice(0, 200)}`)
      e.sent = sent
      e.status = r?.status
      throw e
    }
    return sent
  }

  function makeEv(item) {
    const send = async (chunks) => ({ kind: 'push', sent: await sendChunks(item.psid, chunks) })
    return {
      platform: 'messenger',
      chatId: item.psid,
      userId: item.psid,
      text: item.text,
      isGroup: item.isGroup,
      messageId: item.mid,
      send,
      typing: () => typingOn(item.psid),
    }
  }

  function handler(req, res) {
    const url = new URL(req.url, 'http://localhost')
    if (req.method === 'GET') { // subscription verification handshake
      const mode = url.searchParams.get('hub.mode')
      const tok = url.searchParams.get('hub.verify_token')
      const challenge = url.searchParams.get('hub.challenge')
      if (mode === 'subscribe' && m.verifyToken && tok === m.verifyToken) { res.statusCode = 200; res.end(challenge || ''); return }
      res.statusCode = 403; res.end('forbidden'); return
    }
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', async () => {
      if (!verifyMessengerSignature(appSecret, raw, req.headers['x-hub-signature-256'])) {
        res.statusCode = 401; res.end('bad signature'); return
      }
      // Ack first: Meta retries a webhook that does not answer 200 within 20 s and the
      // AI turn is far slower than that.
      res.statusCode = 200; res.end('{"status":"ok"}')
      let body
      try { body = JSON.parse(raw || '{}') } catch { return }
      for (const item of parseMessengerBody(body, {
        isAllowed: (psid) => !allowedUsers.size || allowedUsers.has(psid),
      })) {
        if (seen.has(item.mid)) continue
        seen.add(item.mid)
        setTimeout(() => seen.delete(item.mid), 60000).unref?.()
        bridge.onInbound(makeEv(item))
      }
    })
  }

  return {
    name: 'messenger',
    configured: !!token,
    // Standalone push used by broadcast (only reaches people who wrote to the Page
    // within the last 24 h, unless outOfWindowTag carries a permitted tag).
    send: async (chatId, chunks) => ({ kind: 'push', sent: await sendChunks(String(chatId), chunks) }),
    async start() {
      if (!token) { log('messenger: no Page access token — adapter idle'); return }
      // Without an App Secret there is no way to prove a call came from Meta, and the
      // sender id in the body is whatever the caller types — that is an open door into
      // the AI under any identity. So the route is simply not opened until it is set:
      // App Dashboard → Settings → Basic → App Secret, or MESSENGER_APP_SECRET.
      if (!appSecret) {
        log('messenger: ⚠️ no App Secret, so the webhook stays closed — an unsigned callback could invent any sender and talk to the AI as that person. Set messenger.appSecret (App Dashboard → Settings → Basic → App Secret) or MESSENGER_APP_SECRET, then tick this channel again.')
        return
      }
      if (!webServer?.register) { log('messenger: webServer service unavailable — cannot register webhook'); return }
      dispose = webServer.register({ kind: 'exact', path: m.webhookPath, handler })
      log(`messenger: webhook registered at ${m.webhookPath} — point Meta\u2019s Page webhook here (subscribe the "messages" field), set the verify token, and keep the App Secret identical on both sides: every X-Hub-Signature-256 is enforced`)
    },
    async stop() { dispose?.() },
  }
}
