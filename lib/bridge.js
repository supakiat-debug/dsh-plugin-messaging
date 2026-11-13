// bridge.js — transport-agnostic orchestration.
//
// An adapter parses a platform event into an `ev` and calls bridge.onInbound(ev):
//   ev = {
//     platform, chatId, userId, text, isGroup, messageId,
//     send(chunks, meta) -> {kind:'push'|'reply'},   // required
//     typing(),                                       // optional
//     startStatus(text) -> { update(t), replace(t), stop() } // optional (edit-capable)
//   }
//
// The bridge binds a dsh session per chat, creates/resumes an agent exactly the
// way the web host does (same agentPresets roster + persistence + title), runs
// the turn, folds the reply, translates it to the configured reply language,
// appends a working-status footer (elapsed / t/s), chunks it, and sends.
//
// Agent/session calls mirror dsh-plugin-discord (create/resume/followup/whenIdle/
// snapshotEvents). They are wrapped defensively because the exact surface is
// owned by dsh-agent / dsh-session and must be smoke-tested against a live host.

import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import os from 'node:os'

import { parseCommand } from './commands.js'
import { chunkReply, HARD_LIMITS } from './chunk.js'
import { findPromptSeq, extractReply } from './reply.js'
import { sysText, labels, HELP_LINES } from './messages.js'
import { LANGUAGES } from './translate.js'
import { ACCESS_LEVELS, accessLevel, accessSupported, accessState, applyAccess, permissionService, approvalService } from './permissions.js'
import { mcpList, mcpSet } from './mcpctl.js'

const LANG_CODES = new Set(LANGUAGES.map((l) => l.code))

// Producer-owned source kind for the injected capability notice (format v4).
const NOTICE_SOURCE = Object.freeze({ kind: 'plugin:dsh-plugin-messaging', form: 'instructions' })

function userMessage(content, source) {
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: Object.freeze([...content]),
    source: Object.freeze({ ...source }),
  })
}

function lastUsage(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    const u = e?.data?.usage ?? e?.usage ?? e?.data?.stats ?? e?.stats
    const out = u?.outputTokens ?? u?.output_tokens ?? u?.completion_tokens
    if (out) return { outputTokens: out }
  }
  return null
}

// Short per-platform tags for session titles (MSG-<Tag>) and the [MSG-<TAG>] prefix
// that shareSession tags relayed prompts / broadcast copies with.
const PLATFORM_TAG = { line: 'Line', telegram: 'TG', whatsapp: 'WA', discord: 'DC' }
const shortTag = (p) => PLATFORM_TAG[p] || String(p || '?')

// /tools accepts the flag in English or Thai, in either position.
const ON_WORDS = new Set(['on', 'open', 'enable', 'enabled', 'start', 'true', 'yes', 'y', '1', 'เปิด', 'เปิดใช้', 'ใช้งาน'])
const OFF_WORDS = new Set(['off', 'close', 'disable', 'disabled', 'stop', 'false', 'no', 'n', '0', 'ปิด', 'ปิดใช้'])
const LIST_WORDS = new Set(['list', 'ls', 'all', 'status', 'show', 'รายการ', 'ทั้งหมด'])

// One-line permission report. The level key prints when the effective preset maps
// to one of the three we advertise; a hand-mixed knob state prints as `custom`,
// which is worth showing verbatim rather than rounding to the nearest level.
function accessReport(L, st) {
  const level = ACCESS_LEVELS.find((l) => l.preset === st.preset)
  const head = level ? `${level.emoji} ${L.access} = ${level.key}` : `🔐 ${L.access} = ${st.preset}`
  return `${head}\n${L.preset}: ${st.preset} · ${L.sandbox}: ${st.sandbox} · ${L.approval}: ${st.approval}`
}

// One line per MCP server: state, name, off-origin tag, live tool count.
function toolsReport(L, servers) {
  return servers.map((s) => {
    const origin = s.source && s.source !== 'user' ? ` (${s.source})` : ''
    return `${s.enabled ? '✅' : '⬜'} ${s.serverName}${origin} — ${s.live?.toolCount ?? 0} ${L.toolsCount}`
  }).join('\n')
}

export function createBridge({ cfg, ctx, store, counter, translator, adapters = {}, log = () => {} }) {
  const queues = new Map() // chatKey -> promise chain (serialize per chat)
  const primed = new WeakSet() // agents that already received the capability notice
  const targets = new Map() // platform -> last inbound chatId (broadcast copy destination)
  // sessionId -> { platform, chatId, lang } of the chat that last drove the session,
  // so an AI-initiated push (request_access) can find its way back to that chat.
  const chats = new Map()

  const svc = (name) => { try { return ctx.get(name) } catch { return undefined } }
  // shareSession collapses every platform onto ONE shared session key so you can talk
  // into the same conversation from any channel; otherwise each chat keeps its own.
  const chatKey = (ev) => (cfg.broadcast?.shareSession ? 'broadcast:shared' : `${ev.platform}:${ev.chatId}`)
  const sessionId = (id) => (String(id).startsWith('session-') ? id : `session-${id}`)
  // Per-chat language override, falling back to the configured default.
  const resolveLang = (binding) => (binding?.lang && LANG_CODES.has(binding.lang) ? binding.lang : cfg.replyLanguage)

  function enqueue(key, fn) {
    const prev = queues.get(key) ?? Promise.resolve()
    const next = prev.then(fn, fn).catch((e) => log('queue error: ' + (e?.stack || e)))
    queues.set(key, next)
    return next
  }

  function onInbound(ev) {
    return enqueue(chatKey(ev), () => handle(ev).catch(async (e) => {
      log('inbound error: ' + (e?.stack || e))
      try { ev.send([await sysText(translator, cfg.replyLanguage, 'internalError', { msg: e?.message || e })]) } catch { /* ignore */ }
    }))
  }

  async function handle(ev) {
    if (cfg.counterEnabled) counter.incInbound()
    targets.set(ev.platform, String(ev.chatId)) // remember where to broadcast replies back to
    const key = chatKey(ev)
    const binding = store.get(key) || {}
    const lang = resolveLang(binding)

    const cmd = parseCommand(ev.text)
    if (cmd?.type === 'unknown') return ev.send([await sysText(translator, lang, 'unknownCommand', { name: cmd.name })])
    if (cmd) return handleCommand(cmd, ev, key, binding, lang)

    const agent = await ensureAgent(ev, key, binding)
    await runPrompt(ev, agent, binding)
  }

  // ---- agent / session lifecycle -------------------------------------------

  function agentOptions() {
    const sel = svc('agentDefaultModel')?.currentSelection?.() ?? {}
    return {
      ...('provider' in sel && sel.provider ? { provider: sel.provider } : {}),
      ...('model' in sel && sel.model ? { model: sel.model } : {}),
    }
  }

  async function composeSetup(presetId) {
    // Mirror the web host: mount the agent-preset roster so a bridge session gets the
    // SAME tools a web agent has. An empty presetId resolves to the deployment default
    // (presets.resolve(undefined)) — exactly what the web UI runs — so we must NOT skip
    // mounting when presetId is empty (that silently left bridge sessions tool-less).
    const presets = svc('agentPresets')
    let resolvedId = presetId
    let mountable = presets !== undefined
    if (presets) {
      try { resolvedId = (await presets.resolve(presetId))?.id ?? presetId }
      catch (e) { log('preset resolve failed: ' + e.message); mountable = false }
    } else log('agentPresets service unavailable — session will have no preset tools')
    // The scoped request_access tool is registered on this SAME setup hook, so it
    // exists on bridge sessions and on no other agent (the pattern dsh-subagent-
    // in-process-driver uses for its per-child structured-output tool).
    const setup = async (agentCtx) => {
      if (mountable) { try { await presets.mount(agentCtx, resolvedId) } catch (e) { log('preset mount failed: ' + e.message) } }
      if (cfg.aiAccessRequest !== false) registerAccessTool(agentCtx)
    }
    return mountable ? { agentPreset: resolvedId, setup } : { setup }
  }

  // ---- AI-initiated access request ------------------------------------------

  // A model that hits a permission wall (a path outside the workspace, a command
  // that wants approval) can ask for more room instead of failing silently. The
  // tool only PUSHES a chat message asking the user to reply /access <level>;
  // the bridge never moves a knob on the model's say-so — the user's command is
  // the single way the permission changes, which keeps the escalation opt-in.
  const REQUEST_ACCESS_TOOL = {
    name: 'request_access',
    description:
      'Ask the user of this chat to raise the session access level. Use it only when a step you need is blocked by the current permission and doing it another way is not viable; describe what you were blocked on. The user grants by replying "/access read|write|full" — nothing changes until they do, so never claim access was given and never re-run the blocked step expecting a different result.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        level: {
          type: 'string',
          enum: ['read', 'write', 'full'],
          description: 'read = nothing may be modified; write = modify files inside the workspace; full = unrestricted shell and file access without approval.',
        },
        reason: { type: 'string', description: 'One sentence shown verbatim to the user: what was blocked and what this level would let you do.' },
      },
      required: ['level', 'reason'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { sent: { type: 'boolean' }, detail: { type: 'string' } },
        required: ['sent', 'detail'],
      },
      render: (_args, value) => [{ type: 'text', text: value.sent ? `Access request (${value.detail}) delivered to the chat.` : `Access request not sent: ${value.detail}` }],
    },
    async execute(args, exec) {
      const sid = exec?.agent?.session?.id
      const chat = sid ? chats.get(sid) : null
      if (!chat) return { sent: false, detail: 'this session is not attached to a messaging chat right now' }
      const adapter = adapters[chat.platform]
      if (!adapter?.send) return { sent: false, detail: `the ${chat.platform} adapter is not running` }
      const level = accessLevel(args.level) ?? ACCESS_LEVELS[ACCESS_LEVELS.length - 1]
      try {
        // Only the fixed phrases are translated; the model's own reason is sent verbatim.
        const L = await labels(translator, chat.lang, ['accessRequestTitle', 'accessGrantHint', 'accessKeepHint'])
        const reason = String(args.reason || '').slice(0, 600)
        await pushChat(chat, `🔐 ${L.accessRequestTitle}: ${level.emoji} ${level.key} (${level.preset})`
          + (reason ? `\n${reason}` : '')
          + `\n\n${L.accessGrantHint}: /access ${level.key}\n${L.accessKeepHint}`)
        return { sent: true, detail: `${level.key} requested` }
      } catch (e) {
        return { sent: false, detail: String(e?.message || e) }
      }
    },
  }

  function registerAccessTool(agentCtx) {
    try { agentCtx.tools.register(REQUEST_ACCESS_TOOL) }
    catch (e) { log('could not register request_access: ' + (e?.message || e)) }
  }

  /** Send text into the chat that last drove this session (chunked per platform). */
  async function pushChat(chat, text) {
    const adapter = adapters[chat.platform]
    if (!adapter?.send) throw new Error(`the ${chat.platform} adapter is not running`)
    const chunks = chunkReply(text, cfg.maxCharsPerMessage, cfg.maxChunksPerReply, HARD_LIMITS[chat.platform] ?? 4096, '')
    if (chunks.length) await adapter.send(chat.chatId, chunks)
  }

  function applyTitle(agent, title) {
    const titles = svc('sessionTitle')
    try { titles?.rename?.(agent.session, title) } catch (e) { log('title rename failed: ' + e.message) }
  }

  async function createSession(key, ev) {
    const cwd = cfg.cwd || os.homedir()
    try { await mkdir(cwd, { recursive: true }) } catch { /* ignore */ }
    const composition = await composeSetup(cfg.preset || undefined)
    const id = `session-${randomUUID()}`
    const handle = await ctx.agents.create({
      sessionId: id,
      meta: { cwd, ...('agentPreset' in composition ? { agentPreset: composition.agentPreset } : {}) },
      agentOptions: agentOptions(),
      setup: composition.setup,
    })
    const agent = handle.agent
    applyTitle(agent, `MSG-${shortTag(ev.platform)} ${ev.title || ev.chatId}`)
    store.set(key, { ...(store.get(key) || {}), sessionId: id, platform: ev.platform, chatId: String(ev.chatId) })
    return agent
  }

  async function acquire(rawId) {
    const id = sessionId(rawId)
    const live = ctx.agents.get(id)
    if (live) return live
    const composition = await composeSetup(cfg.preset || undefined)
    const { agent } = await ctx.agents.resume({ resumeSessionId: id, agentOptions: agentOptions(), setup: composition.setup })
    return agent
  }

  async function ensureAgent(ev, key, binding) {
    if (binding.sessionId) {
      try { return await acquire(binding.sessionId) }
      catch (e) { log(`bound session ${binding.sessionId} could not resume (${e?.message}); creating a new one`) }
    }
    return createSession(key, ev)
  }

  function injectNoticeOnce(agent) {
    if (primed.has(agent) || !cfg.replyLengthPrompt) return
    primed.add(agent)
    try { agent.inject(userMessage([{ type: 'text', text: cfg.replyLengthPrompt }], NOTICE_SOURCE)) }
    catch (e) { log('capability notice failed: ' + e.message) }
  }

  // ---- prompt turn ----------------------------------------------------------

  async function runPrompt(ev, agent, binding) {
    injectNoticeOnce(agent)
    const lang = resolveLang(binding)
    // Remember which chat drives this session, so request_access can push back into it.
    if (agent.session?.id) chats.set(agent.session.id, { platform: ev.platform, chatId: String(ev.chatId), lang })

    ev.typing?.()
    // The "thinking" status is a bridge message -> translated. The elapsed timer
    // reuses the translated base and only appends a language-neutral "Ns".
    const thinking = await sysText(translator, lang, 'thinking')
    const started = Date.now()
    // startStatus may be async (adapters await sendMessage to capture the message id),
    // so await it — otherwise `status` is a Promise and status.replace/update are missing.
    const status = await ev.startStatus?.(thinking)
    const timer = status ? setInterval(() => {
      try { status.update(`${thinking} ${Math.round((Date.now() - started) / 1000)}s`) } catch { /* ignore */ }
    }, 2000) : null

    try {
      const source = { kind: 'user', platform: ev.platform, chatId: String(ev.chatId), messageId: String(ev.messageId ?? '') }
      // In shareSession mode every channel feeds one session, so tag the prompt with
      // its origin (e.g. "[MSG-TG] …") — otherwise the model can't tell who said what.
      const promptText = cfg.broadcast?.shareSession ? `[MSG-${shortTag(ev.platform)}] ${ev.text}` : ev.text
      agent.followup(userMessage([{ type: 'text', text: promptText }], source))
      await agent.whenIdle()

      try { await svc('sessions')?.flush?.(agent.session) } catch { /* ignore */ }
      const log0 = agent.session
      const events = log0?.snapshotEvents?.() ?? log0?.events ?? []
      const seq = findPromptSeq(events, (s) => s?.platform === source.platform && s?.messageId === source.messageId)
      const { text, reasonKind, errorMessage } = extractReply(events, seq)

      // The AI's own answer (text) is sent VERBATIM — never translated. Only the
      // bridge's fallback messages (no answer / error / max-token style reasons)
      // go through the translator.
      let body, isBridgeMsg = false
      if (seq === undefined) { body = await sysText(translator, lang, 'cancelled'); isBridgeMsg = true }
      else if (text) body = text
      else if (errorMessage) { body = await sysText(translator, lang, 'error', { msg: errorMessage }); isBridgeMsg = true }
      else if (reasonKind && reasonKind !== 'completed' && reasonKind !== 'end_turn') { body = await sysText(translator, lang, 'endedUnknown', { kind: reasonKind }); isBridgeMsg = true }
      else { body = await sysText(translator, lang, 'noAnswer'); isBridgeMsg = true }

      const finalText = cfg.showStatsFooter ? body + buildFooter(started, events) : body
      const notice = await sysText(translator, lang, 'truncated')
      const chunks = chunkReply(finalText, cfg.maxCharsPerMessage, cfg.maxChunksPerReply, HARD_LIMITS[ev.platform] ?? 4096, notice)
      let kind = 'push'
      if (status && chunks.length) {
        await status.replace(chunks[0])
        if (chunks.length > 1) { const r = await ev.send(chunks.slice(1)); kind = r?.kind ?? 'push' }
        else kind = 'reply'
      } else {
        const r = await ev.send(chunks); kind = r?.kind ?? 'push'
      }
      if (cfg.counterEnabled) counter.incOutbound({ chunks: chunks.length, kind, translated: isBridgeMsg && lang !== 'en' })

      // One-way broadcast: copy this answer to each ticked platform's last-known chat.
      // Best-effort — a dead channel must never fail the origin turn.
      await broadcastReply(ev, body)
    } finally {
      if (timer) clearInterval(timer)
      try { status?.stop?.() } catch { /* ignore */ }
    }
  }

  // Copy the AI answer (already delivered to the origin chat) one-way to every ticked
  // platform that is live and has a recorded chat. Each send is caught so a dead
  // channel can't break the turn; the origin and shareSession's shared session are
  // skipped (same conversation, no point duplicating into itself). The stats footer is
  // origin-specific, so copies use the bare `body`, tagged with the ORIGIN platform.
  async function broadcastReply(ev, body) {
    const bc = cfg.broadcast
    if (!bc?.enabled || !body) return
    const origin = ev.platform
    for (const p of bc.platforms || []) {
      if (p === origin) continue
      const adapter = adapters[p]
      const chatId = targets.get(p)
      if (!adapter?.send || !chatId) continue
      try {
        const chunks = chunkReply(`[MSG-${shortTag(origin)}] ${body}`, cfg.maxCharsPerMessage, cfg.maxChunksPerReply, HARD_LIMITS[p] ?? 4096, '')
        if (chunks.length) await adapter.send(chatId, chunks)
      } catch (e) { log(`broadcast -> ${p} failed: ${e?.message || e}`) }
    }
  }

  function buildFooter(started, events) {
    const secs = (Date.now() - started) / 1000
    const usage = lastUsage(events)
    const parts = [`⏱ ${secs.toFixed(1)}s`]
    if (usage?.outputTokens && secs > 0) parts.push(`${Math.round(usage.outputTokens / secs)} t/s`)
    return '\n\n' + parts.join(' · ')
  }

  // ---- commands -------------------------------------------------------------

  async function handleCommand(cmd, ev, key, binding, lang) {
    const agents = ctx.agents
    switch (cmd.type) {
      case 'new':
        store.delete(key)
        return ev.send([await sysText(translator, lang, 'newSession')])
      case 'current': {
        if (!binding.sessionId) return ev.send([await sysText(translator, lang, 'currentNone')])
        const L = await labels(translator, lang, ['session'])
        return ev.send([`📌 ${L.session}: ${binding.sessionId}`])
      }
      case 'stop':
        if (binding.sessionId) { try { agents.get?.(sessionId(binding.sessionId))?.cancel?.({ kind: 'user' }) } catch { /* ignore */ } }
        return ev.send([await sysText(translator, lang, 'stopped')])
      case 'lang': {
        const code = (cmd.arg || '').toLowerCase()
        if (!LANG_CODES.has(code)) {
          return ev.send([await sysText(translator, lang, 'langUsage', { list: LANGUAGES.map((l) => `${l.code} ${l.flag}${l.label}`).join(', ') })])
        }
        store.set(key, { ...binding, lang: code })
        const l = LANGUAGES.find((x) => x.code === code)
        const L = await labels(translator, lang, ['replyLang'])
        return ev.send([`🌐 ${L.replyLang} = ${l.flag} ${l.label}`])
      }
      case 'count': {
        const s = counter.snapshot()
        const L = await labels(translator, lang, ['month', 'inbound', 'outbound', 'realMessages', 'pushMetered', 'replyFree', 'translated'])
        return ev.send([
          `📊 ${L.month} ${s.month}\n${L.inbound}: ${s.inbound}\n${L.outbound}: ${s.outboundMsg} (${L.realMessages} ${s.outboundChunks})\n` +
          `${L.pushMetered}: ${s.pushMsgs} · ${L.replyFree}: ${s.replyMsgs}\n${L.translated}: ${s.translated}`,
        ])
      }
      case 'status': {
        const s = counter.snapshot()
        const L = await labels(translator, lang, ['status', 'session', 'noSession', 'language', 'platform', 'thisMonth', 'recv', 'sent'])
        return ev.send([
          `🤖 ${L.status}: ${binding.sessionId ? `${L.session} ${binding.sessionId}` : L.noSession}\n` +
          `${L.language}: ${binding.lang || cfg.replyLanguage} · ${L.platform}: ${ev.platform}\n` +
          `${L.thisMonth}: ${L.recv} ${s.inbound} / ${L.sent} ${s.outboundMsg}`,
        ])
      }
      case 'sessions': {
        const list = store.entries().filter(([, v]) => v.sessionId).slice(0, 10)
        const L = await labels(translator, lang, ['boundSessions', 'noBound'])
        return ev.send([list.length ? `📚 ${L.boundSessions}:\n` + list.map(([k, v]) => `• ${k} → ${v.sessionId}`).join('\n') : `📚 ${L.noBound}`])
      }
      case 'use': {
        if (!cmd.arg) return ev.send([await sysText(translator, lang, 'useUsage')])
        store.set(key, { ...binding, sessionId: cmd.arg })
        const L = await labels(translator, lang, ['bound'])
        return ev.send([`🔗 ${L.bound} ${cmd.arg}`])
      }
      case 'quota':
        return ev.send([await sysText(translator, lang, 'quota')])
      case 'access': {
        // Permission switch for THIS chat's session. Only the user's own command
        // moves a knob; the AI can merely ask (request_access pushes a message).
        if (cfg.accessCommands === false) return ev.send([await sysText(translator, lang, 'accessUnsupported')])
        const pp = permissionService(ctx)
        if (!pp) return ev.send([await sysText(translator, lang, 'accessUnsupported')])
        const L = await labels(translator, lang, ['access', 'preset', 'sandbox', 'approval', 'available'])
        const arg = (cmd.arg || '').trim().toLowerCase()
        // No argument (or an explicit "status") reports the effective knobs — never changes anything.
        if (arg === '' || /^(status|current|state|show|list|ls)$/.test(arg)) {
          if (!binding.sessionId) return ev.send([await sysText(translator, lang, 'accessNone')])
          let agent
          try { agent = await acquire(binding.sessionId) }
          catch (e) { return ev.send([await sysText(translator, lang, 'accessFailed', { msg: e?.message || e })]) }
          return ev.send([accessReport(L, accessState(pp, ctx, agent.session))])
        }
        // Short alias first; then a literal preset name, since a deployment may
        // rename its catalog and the built-in /permission command speaks those.
        const target = accessLevel(arg)
          ?? (Array.isArray(pp.names) && pp.names.includes(arg) ? { key: arg, preset: arg, emoji: '🔐' } : null)
        if (!target) return ev.send([await sysText(translator, lang, 'accessUsage')])
        if (!accessSupported(pp, target)) {
          return ev.send([await sysText(translator, lang, 'accessNoPreset', { name: target.preset, list: (pp.names || []).join(', ') })])
        }
        try {
          // Creates the session when the chat has none yet: /access write as the
          // very first message is a legitimate way to open a writable session.
          const agent = await ensureAgent(ev, key, binding)
          if (agent.session?.id) chats.set(agent.session.id, { platform: ev.platform, chatId: String(ev.chatId), lang })
          const st = applyAccess(pp, approvalService(ctx), ctx, agent, target)
          return ev.send([accessReport(L, st)])
        } catch (e) {
          return ev.send([await sysText(translator, lang, 'accessFailed', { msg: e?.message || e })])
        }
      }
      case 'tools': {
        // MCP on/off, delegated to dsh-mcp-manager-plus's loopback API so the
        // patch file keeps one writer and the live reload stays its business.
        if (cfg.mcpCommands === false) return ev.send([await sysText(translator, lang, 'toolsUsage')])
        const L = await labels(translator, lang, ['mcpServers', 'toolsCount', 'onState', 'offState', 'mcpEnabled', 'mcpDisabled', 'mcpAlready', 'mcpApplying', 'mcpBuiltin', 'mcpAmbiguous', 'mcpNotFound', 'available'])
        const words = (cmd.arg || '').trim().toLowerCase().split(/\s+/).filter(Boolean)
        const last = words.length ? words[words.length - 1] : ''
        const on = ON_WORDS.has(last)
        const off = OFF_WORDS.has(last)
        // Names carry no spaces; extra words are rejoined with '-' so the tolerant
        // "/tools laya browser on" still reaches a server named "laya-browser".
        const name = words.slice(0, -1).join('-')
        try {
          if (!words.length || LIST_WORDS.has(words[0])) {
            const servers = await mcpList(ctx)
            if (!servers.length) return ev.send([`🧰 ${await sysText(translator, lang, 'toolsNone')}`])
            return ev.send([`🧰 ${L.mcpServers}:\n` + toolsReport(L, servers)])
          }
          // Needs both halves: a bare "/tools laya" or a bare "/tools off" is usage.
          if ((!on && !off) || !name) return ev.send([await sysText(translator, lang, 'toolsUsage')])
          const r = await mcpSet(ctx, name, on)
          if (r.missing) return ev.send([`🧰 ${L.mcpNotFound}: "${name}"\n${L.available}: ${(r.known || []).join(', ') || '—'}`])
          if (r.ambiguous) return ev.send([`🧰 ${L.mcpAmbiguous}: ${r.ambiguous.join(', ')}`])
          if (r.builtin) return ev.send([`⚠️ ${r.name} — ${L.mcpBuiltin}`])
          if (r.unchanged) return ev.send([`${on ? '✅' : '⬜'} ${r.name} — ${L.mcpAlready} ${on ? L.onState : L.offState}`])
          return ev.send([`${on ? '✅' : '⬜'} ${r.name} → ${on ? L.mcpEnabled : L.mcpDisabled}\n⏳ ${L.mcpApplying}`])
        } catch (e) {
          return ev.send([await sysText(translator, lang, 'toolsUnreachable', { msg: e?.message || e })])
        }
      }
      case 'help':
      default:
        return ev.send([await sysText(translator, lang, 'help', { lines: HELP_LINES.join('\n') })])
    }
  }

  return { onInbound }
}
