// adapters/line.js — LINE Messaging API adapter (webhook only).
//
// LINE REQUIRES a public HTTPS callback URL. DSH binds 127.0.0.1 with no TLS, so
// you must front it with a tunnel (cloudflared/ngrok), a reverse proxy, or an
// outbound relay, and set `publicBaseUrl` + the webhook path in the LINE console.
//
// Cost note: the reply token is single-use and valid ~60s. AI turns usually
// exceed that, so most replies fall back to metered Push. We try reply first
// (free) when preferReplyToken is on, and record push vs reply in the counter.

import { createHmac, timingSafeEqual } from 'node:crypto'

export function createLineAdapter(cfg, { bridge, log = () => {}, ctx }) {
  const l = cfg.line
  const channelSecret = l.channelSecret || process.env[l.channelSecretEnv] || ''
  const token = l.channelAccessToken || process.env[l.channelAccessTokenEnv] || ''
  const allowedUsers = new Set((l.allowedUserIds || []).map(String))
  const allowedGroups = new Set((l.allowedGroupIds || []).map(String))
  const allowedRooms = new Set((l.allowedRoomIds || []).map(String))
  const seen = new Set()
  const webServer = ctx.get?.('webServer')
  let dispose

  function verify(rawBody, sig) {
    if (!channelSecret) return true // dev mode: no secret configured
    const mac = createHmac('sha256', channelSecret).update(rawBody || '', 'utf8').digest('base64')
    try { return timingSafeEqual(Buffer.from(mac), Buffer.from(sig || '')) } catch { return false }
  }

  async function push(chatId, text) {
    const res = await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ to: chatId, messages: [{ type: 'text', text }] }),
    })
    if (!res.ok) log('line push ' + res.status + ' ' + (await res.text().catch(() => '')))
    return res.ok
  }
  async function replyByToken(replyToken, text) {
    const res = await fetch('https://api.line.me/v2/bot/message/reply', {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ replyToken, messages: [{ type: 'text', text }] }),
    })
    return res.ok
  }
  async function loading(chatId) {
    try {
      await fetch('https://api.line.me/v2/bot/chat/loading/start', {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ chatId, loadingSeconds: 20 }),
      })
    } catch { /* ignore */ }
  }

  function allowed(src, kind) {
    if (kind === 'group' && allowedGroups.size && !allowedGroups.has(src.groupId)) return false
    if (kind === 'room' && allowedRooms.size && !allowedRooms.has(src.roomId)) return false
    if (kind === 'user' && allowedUsers.size && !allowedUsers.has(src.userId)) return false
    return true
  }

  function makeEv(src, kind, msg, replyToken) {
    const chatId = src.groupId || src.roomId || src.userId
    const canReply = replyToken && l.preferReplyToken
    const send = async (chunks) => {
      let usedReply = false
      for (let i = 0; i < chunks.length; i++) {
        if (i === 0 && canReply) {
          if (await replyByToken(replyToken, chunks[i])) { usedReply = true; continue }
        }
        await push(chatId, chunks[i])
      }
      return { kind: usedReply ? 'reply' : 'push' }
    }
    if (kind === 'user' && cfg.loadingIndicator) loading(chatId)
    return {
      platform: 'line', chatId, userId: String(src.userId ?? ''), text: msg.text,
      isGroup: kind === 'group', messageId: msg.id, send, typing: () => {},
    }
  }

  function handler(req, res) {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', async () => {
      if (!verify(raw, req.headers['x-line-signature'])) { res.statusCode = 401; res.end('bad signature'); return }
      let body
      try { body = JSON.parse(raw || '{}') } catch { res.statusCode = 400; res.end('bad json'); return }
      res.statusCode = 200; res.end('{}') // ack fast; process asynchronously
      for (const e of (body.events || [])) {
        if (e.type !== 'message' || e.message?.type !== 'text') continue
        const src = e.source || {}
        const kind = src.groupId ? 'group' : src.roomId ? 'room' : 'user'
        if (!allowed(src, kind)) continue
        const id = e.message.id
        if (seen.has(id)) continue
        seen.add(id); setTimeout(() => seen.delete(id), 60000).unref?.()
        bridge.onInbound(makeEv(src, kind, e.message, e.replyToken))
      }
    })
  }

  return {
    name: 'line',
    configured: !!token,
    // Standalone push used by broadcast (metered Push API, no reply token available).
    send: async (chatId, chunks) => {
      for (const c of chunks) await push(chatId, c)
      return { kind: 'push' }
    },
    async start() {
      if (!token) { log('line: no channel access token — adapter idle'); return }
      if (!webServer?.register) { log('line: webServer service unavailable — cannot register webhook'); return }
      dispose = webServer.register({ kind: 'exact', path: l.webhookPath, handler })
      log(`line: webhook registered at ${l.webhookPath} — point your public URL here and set the channel secret`)
    },
    async stop() { dispose?.() },
  }
}
