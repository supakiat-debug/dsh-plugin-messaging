// adapters/discord.js — Discord adapter: OUTBOUND WebSocket gateway + REST.
//
// Discord is the platform that needs no public URL and no tunnel: the bot opens an
// *outbound* WebSocket to the gateway (wss://gateway.discord.gg), so the bridge works
// behind NAT and behind DSH's 127.0.0.1/no-TLS bind with nothing exposed. That is the
// one architectural difference from LINE / WhatsApp / Messenger (webhook in) and it is
// why `keepOpen` for Discord means "stay connected", not "keep a route registered".
//
// The gateway v10 client below is a plain-ESM port of `dsh-plugin-discord`'s TypeScript
// gateway (research note line-bridge-feasibility.md §1, extracted source in
// .research/discord-src/): HELLO → heartbeat → Identify/Resume → READY → MESSAGE_CREATE,
// with resume, close-code handling, zombie detection and capped backoff. Zero
// dependencies — Node's global WebSocket (undici) carries the connection.
//
// Three Discord traps this file exists to handle:
//  1. MESSAGE_CONTENT (bit 1<<15) is a PRIVILEGED intent: switch it on in the Developer
//     Portal (Bot → Privileged Gateway Intents) or every guild message arrives with an
//     EMPTY `content`, which looks exactly like "the bot ignores me". If the gateway
//     refuses the intent (close 4014) we drop the bit, log once, and reconnect rather
//     than loop forever. DM text arrives regardless of this intent, so the bridge stays
//     useful either way.
//  2. Discord (behind Cloudflare) rejects REST calls without a bot-style User-Agent
//     with an opaque 403.
//  3. REST is rate limited per route: a 429 must be retried after `retry_after`, and
//     editing the live-status message is limited to ~5 edits / 5 s per message, so the
//     status timer throttles and gives up on the first failure.
//
// Replies never ping (`allowed_mentions.parse: []`) — a bridge that @-mentioned people
// would be worse than useless in a shared server.

const API_BASE = 'https://discord.com/api/v10'
const GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json'
const STATUS_EDIT_MIN_MS = 4000  // minimum spacing between live-status edits
// Discord's API policy wants a real UA identifying the app. Bump this with package.json.
const USER_AGENT = 'DiscordBot (https://github.com/supakiat-debug/dsh-plugin-messaging, 0.3.0)'

/** Gateway intent bits. Only these three are ever requested. */
export const INTENTS = {
  GUILD_MESSAGES: 1 << 9,
  DIRECT_MESSAGES: 1 << 12,
  MESSAGE_CONTENT: 1 << 15,
}

/** Close codes after which retrying cannot help. 4014 is handled separately. */
const FATAL_CLOSE = new Set([4004, 4010, 4011, 4012, 4013])

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * One long-lived gateway connection (v10, no compression, one shard).
 * `start()` connects and keeps reconnecting with capped backoff until `stop()`.
 * `webSocket` is injectable for tests and defaults to the global (undici) WebSocket.
 */
export class DiscordGateway {
  constructor({ token, intents, url = GATEWAY_URL, hooks = {}, webSocket, maxBackoffMs = 60000 }) {
    this.token = token
    this.intents = intents
    this.url = url
    this.hooks = hooks
    this.Socket = webSocket || globalThis.WebSocket
    this.maxBackoffMs = maxBackoffMs
    this.ws = undefined
    this.stopped = true
    this.heartbeatTimer = undefined
    this.reconnectTimer = undefined
    this.lastSeq = null
    this.sessionId = undefined
    this.resumeUrl = undefined
    this.backoffMs = 1000
    this.ackReceived = true
  }

  /** Whether the client currently holds an open socket. */
  get connected() { return this.ws !== undefined && this.ws.readyState === 1 }

  log(level, text) { this.hooks.log?.(level, text) }

  start() {
    if (this.stopped) { this.stopped = false; this.connect() }
  }

  stop() {
    this.stopped = true
    this.clearTimers()
    if (this.ws !== undefined) {
      // 1000 tells Discord to invalidate the session; that is what we want on an
      // orderly plugin unload, so a later start() identifies fresh.
      try { this.ws.close(1000) } catch { /* already closing */ }
      this.ws = undefined
    }
  }

  clearTimers() {
    if (this.heartbeatTimer !== undefined) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = undefined
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
  }

  connect() {
    if (this.stopped || !this.Socket) return
    const url = this.resumeUrl || this.url
    let ws
    try { ws = new this.Socket(url) } catch (e) {
      this.log('warn', 'gateway connect failed: ' + (e?.message || e))
      this.scheduleReconnect()
      return
    }
    this.ws = ws
    ws.onmessage = (event) => {
      if (typeof event.data !== 'string') return
      let payload
      try { payload = JSON.parse(event.data) } catch { return }
      this.handle(ws, payload)
    }
    ws.onclose = (event) => {
      if (this.ws !== ws) return
      this.ws = undefined
      this.clearTimers()
      if (this.stopped) return
      if (FATAL_CLOSE.has(event.code)) {
        this.stopped = true
        const reason = `gateway closed with terminal code ${event.code}: ${event.reason || 'no reason'}`
        this.log('warn', reason)
        this.hooks.onFatal?.(reason)
        return
      }
      if (event.code === 4014) {
        // Disallowed intents: drop MESSAGE_CONTENT once and retry.
        if ((this.intents & INTENTS.MESSAGE_CONTENT) !== 0) {
          this.intents &= ~INTENTS.MESSAGE_CONTENT
          this.sessionId = undefined
          this.resumeUrl = undefined
          this.log('warn', 'MESSAGE_CONTENT intent refused (enable it in the Discord developer portal); retrying without it — guild message text will be empty, DMs still work')
          this.scheduleReconnect()
          return
        }
        this.stopped = true
        this.hooks.onFatal?.('gateway refused the requested intents')
        return
      }
      // 4007 (reconnect / invalid session id) and 4009 (session timeout): resume is void.
      if (event.code === 4007 || event.code === 4009) {
        this.sessionId = undefined
        this.resumeUrl = undefined
      }
      this.log('warn', `gateway closed (${event.code || 'no code'}); reconnecting`)
      this.scheduleReconnect()
    }
    ws.onerror = () => { /* the paired close event carries the retry decision */ }
  }

  scheduleReconnect() {
    if (this.stopped || this.reconnectTimer !== undefined) return
    const delay = this.backoffMs
    this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs)
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = undefined; this.connect() }, delay)
    this.reconnectTimer.unref?.()
  }

  send(ws, payload) {
    if (!ws || ws.readyState !== 1) return
    try { ws.send(JSON.stringify(payload)) } catch { /* close handler reconnects */ }
  }

  handle(ws, payload) {
    if (typeof payload?.op !== 'number') return
    if (payload.s !== undefined && payload.s !== null) this.lastSeq = payload.s
    switch (payload.op) {
      case 10: {
        const data = payload.d || {}
        this.startHeartbeat(ws, data.heartbeat_interval)
        if (this.sessionId !== undefined) {
          this.send(ws, { op: 6, d: { token: this.token, session_id: this.sessionId, seq: this.lastSeq } })
        } else {
          this.identify(ws)
        }
        return
      }
      case 11: this.ackReceived = true; return
      case 1: this.send(ws, { op: 1, d: this.lastSeq }); return
      case 7:
        // Discord asks us to reconnect (and resume).
        try { ws.close(4900) } catch { /* closing */ }
        return
      case 9: {
        const resumable = payload.d === true
        if (!resumable) { this.sessionId = undefined; this.resumeUrl = undefined; this.lastSeq = null }
        const wait = 1000 + Math.floor(Math.random() * 4000)
        const timer = setTimeout(() => { if (ws.readyState === 1) this.identify(ws) }, wait)
        timer.unref?.()
        return
      }
      case 0: this.dispatch(payload); return
      default:
    }
  }

  identify(ws) {
    if (this.sessionId !== undefined) return
    this.send(ws, {
      op: 2,
      d: {
        token: this.token,
        intents: this.intents,
        properties: { os: process.platform, browser: 'dsh-plugin-messaging', device: 'dsh-plugin-messaging' },
      },
    })
  }

  startHeartbeat(ws, intervalMs) {
    if (typeof intervalMs !== 'number') return
    if (this.heartbeatTimer !== undefined) clearInterval(this.heartbeatTimer)
    this.ackReceived = true
    // First beat after a jittered fraction of the interval, per the gateway docs.
    const first = setTimeout(() => this.send(ws, { op: 1, d: this.lastSeq }), Math.floor(intervalMs * Math.random()))
    first.unref?.()
    this.heartbeatTimer = setInterval(() => {
      if (!this.ackReceived) {
        try { ws.close(4901) } catch { /* closing */ }  // zombied connection: close and resume
        return
      }
      this.ackReceived = false
      this.send(ws, { op: 1, d: this.lastSeq })
    }, intervalMs)
    this.heartbeatTimer.unref?.()
  }

  dispatch(payload) {
    switch (payload.t) {
      case 'READY': {
        const data = payload.d || {}
        this.lastSeq = null
        this.sessionId = data.session_id
        if (data.resume_gateway_url) this.resumeUrl = `${data.resume_gateway_url}/?v=10&encoding=json`
        this.backoffMs = 1000
        this.log('info', 'gateway connected')
        this.hooks.onReady?.({ botUserId: data.user?.id, sessionId: data.session_id })
        return
      }
      case 'RESUMED':
        this.backoffMs = 1000
        this.log('info', 'gateway resumed')
        return
      case 'MESSAGE_CREATE': {
        const data = payload.d
        if (typeof data?.id !== 'string' || typeof data?.channel_id !== 'string') return
        this.hooks.onMessage?.(data)
        return
      }
      default:
    }
  }
}

/**
 * The REST slice the bridge needs, over global fetch. Retries on 429 honouring
 * `retry_after` (capped) and throws otherwise, so callers can log and move on.
 */
export function discordRest({ token, baseUrl = API_BASE, maxRateLimitRetries = 3, fetchImpl } = {}) {
  const post = fetchImpl || fetch
  async function request(method, path, body) {
    for (let attempt = 0; ; attempt++) {
      const res = await post(`${baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bot ${token}`,
          'user-agent': USER_AGENT,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      if (res.status === 429 && attempt < maxRateLimitRetries) {
        const data = await res.json().catch(() => ({}))
        await sleep(Math.ceil(((data?.retry_after ?? 1) + 0.05) * 1000))
        continue
      }
      const text = await res.text().catch(() => '')
      if (!res.ok) throw new Error(`discord ${method} ${path} failed: ${res.status} ${text.slice(0, 300)}`)
      return text ? JSON.parse(text) : undefined
    }
  }
  return {
    /** Identity check — a bad token surfaces here at start() instead of silently idling. */
    getMe: () => request('GET', '/users/@me'),
    createMessage: (channelId, content, replyTo) => request('POST', `/channels/${channelId}/messages`, {
      content,
      allowed_mentions: { parse: [] },
      ...(replyTo ? { message_reference: { message_id: replyTo, fail_if_not_exists: false } } : {}),
    }),
    editMessage: (channelId, messageId, content) => request('PATCH', `/channels/${channelId}/messages/${messageId}`, {
      content, allowed_mentions: { parse: [] },
    }),
    typing: (channelId) => request('POST', `/channels/${channelId}/typing`),
    /** Open (or fetch) the bot's DM channel with one user — used to push to `user:<id>`. */
    createDM: (userId) => request('POST', '/users/@me/channels', { recipient_id: userId }),
  }
}

/**
 * Strip the bot's own mention(s) so `@Bot /new` still parses as `/new`.
 */
export function stripBotMentions(text, botUserId) {
  let out = String(text || '').replace(/\u200b/g, '') // zero-width spaces are invisible noise
  const id = String(botUserId || '').replace(/\D/g, '') // snowflake; never build a regex from raw input
  if (id) out = out.replace(new RegExp(`\\s*<@!?${id}>\\s*`, 'g'), ' ')
  return out.trim()
}

export function createDiscordAdapter(cfg, { bridge, log = () => {} }) {
  const d = cfg.discord
  const token = d.botToken || process.env[d.botTokenEnv] || ''
  const allowedUsers = new Set((d.allowedUserIds || []).map(String))
  const allowedChannels = new Set((d.allowedChannelIds || []).map(String))
  const allowedGuilds = new Set((d.allowedGuildIds || []).map(String))
  const rest = discordRest({ token, baseUrl: d.apiBaseUrl || API_BASE })
  const seen = new Set()
  const dmCache = new Map()
  let gateway = null
  let botUserId = ''
  // `stop()` can land while `start()` is still awaiting getMe(). Without these two the
  // HTTP reply would arrive, the code would merrily open the gateway, and an unloaded
  // plugin would sit there receiving messages with no one to unload its socket.
  let stopped = true
  let startSeq = 0

  /**
   * Post chunks in order to one channel, threading the first under `replyTo`.
   * A failure is tagged with how many chunks already landed, so the bridge counts what
   * the user actually received instead of what we tried to send.
   */
  async function postChunks(channelId, chunks, replyTo) {
    let sent = 0
    for (const c of chunks) {
      try {
        await rest.createMessage(channelId, c, sent === 0 ? replyTo : undefined)
      } catch (e) {
        if (e && typeof e === 'object') e.sent = sent
        throw e
      }
      sent++
    }
    return sent
  }

  /**
   * A guild message needs an explicit @mention unless the config turned that off.
   * (DMs skip this entirely — `allowed()` only calls it for messages with a guild_id.)
   */
  function mentioned(msg) {
    if (d.requireMentionInGuild === false) return true
    const list = Array.isArray(msg.mentions) ? msg.mentions : []
    return Boolean(botUserId) && list.some((m) => String(m?.id) === String(botUserId))
  }

  function allowed(msg) {
    if (msg?.author?.id && String(msg.author.id) === String(botUserId)) return false // never answer ourselves
    if (msg?.author?.bot && d.ignoreBots !== false) return false
    const isGroup = Boolean(msg.guild_id)
    if (isGroup && allowedGuilds.size && !allowedGuilds.has(String(msg.guild_id))) return false
    if (allowedChannels.size && !allowedChannels.has(String(msg.channel_id))) return false
    if (allowedUsers.size && !allowedUsers.has(String(msg.author?.id))) return false
    if (isGroup && !mentioned(msg)) return false
    return true
  }

  /** `user:<id>` / `dm:<id>` opens (and caches) the DM channel; anything else is a channel id. */
  async function resolveChannel(chatId) {
    const raw = String(chatId || '')
    const dm = raw.match(/^(?:user|dm):(.+)$/i)
    if (!dm) return raw
    const userId = dm[1]
    const cached = dmCache.get(userId)
    if (cached) return cached
    const channel = await rest.createDM(userId)
    if (!channel?.id) throw new Error(`could not open a DM channel with ${userId}`)
    dmCache.set(userId, channel.id)
    return channel.id
  }

  /** Send "thinking…", edit it in place, then replace it with the answer (like Telegram). */
  function makeStatus(channelId) {
    return async (initial) => {
      let statusId = ''
      let lastEditAt = 0
      let broken = false
      let pending = null
      const edit = async (text) => {
        if (!statusId || broken) return false
        const ok = await rest.editMessage(channelId, statusId, text).then(() => true).catch((e) => {
          broken = true
          log('discord status edit failed: ' + (e?.message || e))
          return false
        })
        return ok
      }
      try {
        const sent = await rest.createMessage(channelId, initial)
        statusId = sent?.id || ''
      } catch (e) {
        log('discord status send failed: ' + (e?.message || e))
        // No status message: the bridge must fall back to a plain send of the answer.
        return { update: async () => {}, replace: async () => { throw new Error('status message was not delivered') }, stop: () => {} }
      }
      lastEditAt = Date.now()
      return {
        update: async (text) => {
          if (broken || Date.now() - lastEditAt < STATUS_EDIT_MIN_MS) return
          lastEditAt = Date.now()
          pending = edit(text)
          await pending
        },
        replace: async (text) => {
          if (pending) await pending.catch(() => {})
          if (await edit(text)) return
          throw new Error('status message could not be replaced')
        },
        stop: () => { broken = true },
      }
    }
  }

  function makeEv(msg) {
    const channelId = String(msg.channel_id)
    // The first chunk threads under the question, the rest are plain sends.
    const send = async (chunks) => ({ kind: 'push', sent: await postChunks(channelId, chunks, msg.id) })
    const ev = {
      platform: 'discord',
      chatId: channelId,
      userId: String(msg.author?.id ?? ''),
      text: stripBotMentions(msg.content, botUserId),
      isGroup: Boolean(msg.guild_id),
      messageId: msg.id,
      send,
      typing: () => { rest.typing(channelId).catch(() => {}) },
    }
    if (d.editLiveStatus !== false) ev.startStatus = makeStatus(channelId)
    return ev
  }

  function onMessage(msg) {
    if (seen.has(msg.id)) return
    seen.add(msg.id)
    setTimeout(() => seen.delete(msg.id), 60000).unref?.()
    if (!allowed(msg)) return
    const ev = makeEv(msg)
    if (!ev.text) { log('discord: message with no text (attachment only) — ignored'); return }
    bridge.onInbound(ev)
  }

  return {
    name: 'discord',
    configured: !!token,
    /** Standalone push used by broadcast. `chatId` is a channel id, or `user:<id>` for a DM. */
    send: async (chatId, chunks) => ({ kind: 'push', sent: await postChunks(await resolveChannel(chatId), chunks) }),
    async start() {
      if (!token) { log('discord: no bot token — adapter idle'); return }
      stopped = false
      const seq = ++startSeq
      try {
        const me = await rest.getMe()
        botUserId = String(me?.id || '')
        log(`discord: signed in as ${me?.username || me?.id} (no public URL needed)`)
      } catch (e) {
        log(`discord: token rejected (${e?.message || e}) — adapter idle`)
        return
      }
      // getMe() is a network call, and `stop()` may have happened while it was in
      // flight (a config save unloads and rebuilds this adapter). Opening a gateway for
      // an adapter nobody will stop again is how a "disabled" bot keeps answering
      // people, so this is the last checkpoint before the socket.
      if (stopped || seq !== startSeq) {
        log('discord: stopped while signing in — gateway not started')
        return
      }
      let intents = INTENTS.GUILD_MESSAGES | INTENTS.DIRECT_MESSAGES
      if (d.messageContentIntent !== false) intents |= INTENTS.MESSAGE_CONTENT
      gateway = new DiscordGateway({
        token,
        intents,
        url: d.gatewayUrl || GATEWAY_URL,
        hooks: {
          onMessage,
          onReady: (ready) => { if (ready?.botUserId) botUserId = String(ready.botUserId) },
          onFatal: (reason) => log('discord gateway stopped: ' + reason),
          log: (level, text) => log(`discord ${level === 'warn' ? '⚠️ ' : ''}${text}`),
        },
      })
      gateway.start()
      log(`discord: gateway connecting (intents=${intents}, mention required in servers=${d.requireMentionInGuild !== false})`)
    },
    async stop() {
      // Also voids a start() that is still awaiting getMe(): a later start() bumps the
      // sequence itself, so this cannot strand a restart.
      stopped = true
      startSeq++
      gateway?.stop()
      gateway = null
    },
  }
}
