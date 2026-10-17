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

export function createBridge({ cfg, ctx, store, counter, translator, adapters = {}, log = () => {} }) {
  const queues = new Map() // chatKey -> promise chain (serialize per chat)
  const primed = new WeakSet() // agents that already received the capability notice
  const targets = new Map() // platform -> last inbound chatId (broadcast copy destination)

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
    if (!presets) { log('agentPresets service unavailable — session will have no preset tools'); return { setup: async () => {} } }
    try {
      const resolvedId = (await presets.resolve(presetId))?.id ?? presetId
      return {
        agentPreset: resolvedId,
        setup: async (agentCtx) => { try { await presets.mount(agentCtx, resolvedId) } catch (e) { log('preset mount failed: ' + e.message) } },
      }
    } catch (e) {
      log('preset resolve failed: ' + e.message)
      return { setup: async () => {} }
    }
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
      case 'help':
      default:
        return ev.send([await sysText(translator, lang, 'help', { lines: HELP_LINES.join('\n') })])
    }
  }

  return { onInbound }
}
