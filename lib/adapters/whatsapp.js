// adapters/whatsapp.js — WhatsApp Cloud API adapter (webhook only, public HTTPS).
//
// Constraints (see design doc §13): webhook-only + public HTTPS; GET handshake
// (hub.verify_token/challenge); X-Hub-Signature-256 HMAC on the raw body; 4096
// char text; a rolling 24h customer-service window — free-form inside it, an
// approved template outside; no edit; groups need an approved business flow.
// We send free-form text; if the window has closed and outOfWindowTemplate is
// set, we fall back to that template.

import { createHmac, timingSafeEqual } from 'node:crypto'

const GRAPH = 'https://graph.facebook.com/v21.0'

export function createWhatsAppAdapter(cfg, { bridge, log = () => {}, ctx }) {
  const w = cfg.wa
  const token = w.accessToken || process.env[w.accessTokenEnv] || ''
  const appSecret = w.appSecret || process.env[w.appSecretEnv] || ''
  const phoneId = w.phoneNumberId
  const allowedUsers = new Set((w.allowedUserIds || []).map(String))
  const allowedGroups = new Set((w.allowedGroupIds || []).map(String))
  const seen = new Set()
  const webServer = ctx.get?.('webServer')
  let dispose

  /**
   * X-Hub-Signature-256, exactly as in the Messenger adapter: no app secret means no
   * verifiable sender, and the `waId` in the body is caller-chosen — so nothing is
   * accepted and start() will not open the route without one.
   */
  function verifySig(raw, header) {
    if (!appSecret) return false
    const expected = 'sha256=' + createHmac('sha256', appSecret).update(raw || '', 'utf8').digest('hex')
    try { return timingSafeEqual(Buffer.from(expected), Buffer.from(header || '')) } catch { return false }
  }

  async function post(payload) {
    const res = await fetch(`${GRAPH}/${phoneId}/messages`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', ...payload }),
    })
    const body = await res.text().catch(() => '')
    if (!res.ok) log('wa send ' + res.status + ' ' + body)
    return { ok: res.ok, status: res.status, body }
  }
  const sendText = (to, text) => post({ to, type: 'text', text: { body: text } })
  const sendTemplate = (to, name) => post({ to, type: 'template', template: { name, language: { code: 'th' } } })

  function makeEv(msg) {
    const from = msg.from
    const send = async (chunks) => {
      let sent = 0
      for (const c of chunks) {
        const r = await sendText(from, c)
        if (r.ok) { sent++; continue }
        // 400 + window/session error => outside 24h window; try approved template.
        if (r.status === 400 && /window|session|reopen|24/i.test(r.body) && w.outOfWindowTemplate) {
          if (await sendTemplate(from, w.outOfWindowTemplate)) sent++
        }
      }
      return { kind: 'push', sent }
    }
    return { platform: 'whatsapp', chatId: from, userId: from, text: msg.text, isGroup: false, messageId: msg.id, send, typing: () => {} }
  }

  function handler(req, res) {
    const url = new URL(req.url, 'http://localhost')
    if (req.method === 'GET') { // subscription verification handshake
      const mode = url.searchParams.get('hub.mode')
      const tok = url.searchParams.get('hub.verify_token')
      const challenge = url.searchParams.get('hub.challenge')
      if (mode === 'subscribe' && tok === w.verifyToken) { res.statusCode = 200; res.end(challenge || ''); return }
      res.statusCode = 403; res.end('forbidden'); return
    }
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', async () => {
      if (!verifySig(raw, req.headers['x-hub-signature-256'])) { res.statusCode = 401; res.end('bad signature'); return }
      res.statusCode = 200; res.end('{"status":"ok"}')
      let body
      try { body = JSON.parse(raw || '{}') } catch { return }
      for (const entry of (body.entry || [])) {
        for (const change of (entry.changes || [])) {
          for (const msg of (change.value?.messages || [])) {
            if (seen.has(msg.id)) continue
            seen.add(msg.id); setTimeout(() => seen.delete(msg.id), 60000).unref?.()
            const text = msg.text?.body || ''
            if (!text) continue
            if (allowedUsers.size && !allowedUsers.has(msg.from)) continue
            bridge.onInbound(makeEv(msg))
          }
        }
      }
    })
  }

  return {
    name: 'whatsapp',
    configured: !!(token && phoneId),
    // Standalone push used by broadcast (free-form text inside the 24h window).
    send: async (chatId, chunks) => {
      let sent = 0
      for (const c of chunks) if ((await sendText(chatId, c)).ok) sent++
      return { kind: 'push', sent }
    },
    async start() {
      if (!token || !phoneId) { log('whatsapp: missing access token / phoneNumberId — adapter idle'); return }
      if (!appSecret) {
        log('whatsapp: ⚠️ no App Secret, so the webhook stays closed — an unsigned callback could claim any waId and the allowlist would accept it. Set wa.appSecret (Meta app dashboard → Basic settings → App Secret) or WHATSAPP_APP_SECRET, then tick this channel again.')
        return
      }
      if (!webServer?.register) { log('whatsapp: webServer service unavailable — cannot register webhook'); return }
      dispose = webServer.register({ kind: 'exact', path: w.webhookPath, handler })
      log(`whatsapp: webhook registered at ${w.webhookPath} — set this public URL + verify token in Meta console (X-Hub-Signature-256 is enforced)`)
    },
    async stop() { dispose?.() },
  }
}
