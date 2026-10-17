// smoke.mjs — dependency-free unit tests for the pure modules.
// Run: node ./test/smoke.mjs
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { chunkReply, HARD_LIMITS } from '../lib/chunk.js'
import { createTranslator } from '../lib/translate.js'
import { parseCommand } from '../lib/commands.js'
import { sysText, labels, MESSAGES, LABELS } from '../lib/messages.js'
import { BindingStore } from '../lib/state.js'
import { MonthlyCounter } from '../lib/counter.js'
import { findPromptSeq, extractReply } from '../lib/reply.js'
import { resolveConfig, Config } from '../lib/config.js'

let pass = 0, fail = 0
const t = (name, fn) => {
  try { const r = fn(); if (r instanceof Promise) return r.then(() => { pass++; console.log('  ok  ' + name) }, e => { fail++; console.log('FAIL  ' + name + '\n      ' + e.message) })
    pass++; console.log('  ok  ' + name) }
  catch (e) { fail++; console.log('FAIL  ' + name + '\n      ' + e.message) }
}
const tmp = mkdtempSync(join(tmpdir(), 'dshmsg-'))

// ---- chunk ----
await t('chunk: short text -> 1 chunk', () => assert.deepEqual(chunkReply('hi', 1800, 3, 5000), ['hi']))
await t('chunk: empty -> []', () => assert.deepEqual(chunkReply('   ', 1800, 3, 5000), []))
await t('chunk: respects maxChunks=3', () => {
  const big = 'x'.repeat(10000)
  const out = chunkReply(big, 1800, 3, 5000)
  assert.equal(out.length, 3)
  assert.ok(out.every(c => c.length <= 1800), 'each <= budget')
})
await t('chunk: prefers paragraph boundary', () => {
  const text = 'A'.repeat(100) + '\n\n' + 'B'.repeat(100)
  const out = chunkReply(text, 120, 3, 5000)
  assert.equal(out.length, 2)
  assert.ok(out[0].endsWith('A'))
})
await t('chunk: overflow beyond maxChunks truncates', () => {
  const out = chunkReply('word '.repeat(2000), 100, 2, 5000, '…(ตัดจบ)')
  assert.equal(out.length, 2)
  assert.ok(out[1].includes('ตัดจบ'))
})
await t('chunk: default notice is English (AI text never translated)', () => {
  const out = chunkReply('word '.repeat(2000), 100, 2, 5000)
  assert.ok(out[1].includes('truncated'))
})
await t('chunk: hard limits map', () => assert.equal(HARD_LIMITS.telegram, 4096))

// ---- translate ----
await t('translate: google backend + cache + skip-same-lang', async () => {
  let calls = 0
  const fakeFetch = async (url) => {
    calls++
    const u = new URL(url)
    const q = u.searchParams.get('q'), tl = u.searchParams.get('tl')
    const map = { 'zh-CN': '你好', th: 'สวัสดี', en: 'HELLO' }
    return { ok: true, json: async () => [[[map[tl] ?? q, q, null, null, 10]], null, 'en'] }
  }
  const tr = createTranslator({ backend: 'google', fetch: fakeFetch })
  assert.equal(await tr.translate('hello', 'th'), 'สวัสดี')
  assert.equal(calls, 1)
  assert.equal(await tr.translate('hello', 'th'), 'สวัสดี')
  assert.equal(calls, 1, 'cache hit, no second call')
  // detected source 'en' == target 'en' -> keep original, no churn
  assert.equal(await tr.translate('hello', 'en'), 'hello')
})
await t('translate: backend off -> passthrough', async () => {
  const tr = createTranslator({ backend: 'off', fetch: async () => { throw new Error('should not call') } })
  assert.equal(await tr.translate('hello', 'th'), 'hello')
})
await t('translate: network error -> passthrough', async () => {
  const tr = createTranslator({ backend: 'google', fetch: async () => { throw new Error('boom') } })
  assert.equal(await tr.translate('hello', 'th'), 'hello')
})
await t('translate: persists cache to file', async () => {
  const file = join(tmp, 'tr-cache.json')
  const fakeFetch = async () => ({ ok: true, json: async () => [[['X', 'y', null, null, 10]], null, 'en'] })
  const tr = createTranslator({ backend: 'google', cacheFile: file, fetch: fakeFetch })
  await tr.translate('y', 'th')
  assert.ok(readFileSync(file, 'utf8').includes('X'))
})

// ---- commands ----
await t('commands: parse', () => {
  assert.deepEqual(parseCommand('/new my chat'), { type: 'new', arg: 'my chat' })
  assert.deepEqual(parseCommand('/sessions'), { type: 'sessions' })
  assert.deepEqual(parseCommand('/lang th'), { type: 'lang', arg: 'th' })
  assert.equal(parseCommand('hello'), null)
  assert.deepEqual(parseCommand('/nope'), { type: 'unknown', name: 'nope' })
})

// ---- messages (bridge-owned strings; AI replies never go through here) ----
await t('messages: sysText en short-circuits (no translate call)', async () => {
  let called = false
  const tr = { translate: async () => { called = true; return 'X' } }
  assert.equal(await sysText(tr, 'en', 'noAnswer'), MESSAGES.noAnswer)
  assert.equal(called, false, 'en must not call the translator')
})
await t('messages: sysText translates + interpolates {param}', async () => {
  const tr = { translate: async (text) => 'T:' + text }
  assert.equal(await sysText(tr, 'th', 'error', { msg: 'boom' }), 'T:⚠️ boom')
})
await t('messages: sysText error passes base through', async () => {
  const tr = { translate: async () => { throw new Error('net') } }
  assert.equal(await sysText(tr, 'th', 'stopped'), MESSAGES.stopped)
})
await t('messages: labels en returns base labels (no translate)', async () => {
  const L = await labels(null, 'en', ['month', 'inbound'])
  assert.equal(L.month, LABELS.month)
  assert.equal(L.inbound, LABELS.inbound)
})
await t('messages: labels translate each label (dynamic reports)', async () => {
  const tr = { translate: async (text) => 'Z' + text }
  const L = await labels(tr, 'zh', ['month', 'inbound'])
  assert.equal(L.month, 'Z' + LABELS.month)
  assert.equal(L.inbound, 'Z' + LABELS.inbound)
})

// ---- state ----
await t('state: set/get/persist', () => {
  const file = join(tmp, 'state.json')
  const s = new BindingStore(file).load()
  s.set('telegram:1', { sessionId: 'abc' })
  assert.deepEqual(new BindingStore(file).load().get('telegram:1'), { sessionId: 'abc' })
})

// ---- counter ----
await t('counter: increments + persists', () => {
  const file = join(tmp, 'count.json')
  const c = new MonthlyCounter(file)
  c.incInbound(); c.incOutbound({ chunks: 2, kind: 'push', translated: true })
  const snap = new MonthlyCounter(file).snapshot()
  assert.equal(snap.inbound, 1); assert.equal(snap.outboundChunks, 2); assert.equal(snap.pushMsgs, 1); assert.equal(snap.translated, 1)
})
await t('counter: rolls over on month change', () => {
  const file = join(tmp, 'count2.json')
  writeFileSync(file, JSON.stringify({ month: '2000-01', inbound: 99, outboundChunks: 50 }))
  const snap = new MonthlyCounter(file).snapshot()
  assert.notEqual(snap.month, '2000-01'); assert.equal(snap.inbound, 0)
})

// ---- reply ----
await t('reply: fold assistant text until turn/end (last non-empty wins)', () => {
  const events = [
    { seq: 1, type: 'user/message', data: { source: { platform: 'telegram', messageId: 'm1' } } },
    { seq: 2, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Hello ' }] } } },
    { seq: 3, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Hello world' }] } } },
    { seq: 4, type: 'turn/end', data: { reason: { kind: 'completed' } } },
  ]
  const seq = findPromptSeq(events, (s) => s?.platform === 'telegram' && s?.messageId === 'm1')
  assert.equal(seq, 1)
  const { text, reasonKind } = extractReply(events, seq)
  assert.equal(text, 'Hello world')
  assert.equal(reasonKind, 'completed')
})
await t('reply: captures turn error', () => {
  const events = [
    { seq: 1, type: 'user/message', data: { source: { platform: 'telegram', messageId: 'm2' } } },
    { seq: 2, type: 'turn/end', data: { reason: { kind: 'error', error: { message: 'model blew up' } } } },
  ]
  const { errorMessage } = extractReply(events, findPromptSeq(events, (s) => s?.messageId === 'm2'))
  assert.equal(errorMessage, 'model blew up')
})
await t('reply: undefined promptSeq -> empty (no crash)', () => {
  const { text } = extractReply([{ seq: 1, type: 'turn/end', data: {} }], undefined)
  assert.equal(text, '')
})

// ---- module graph (syntax + exports of the cordis-coupled files) ----
await t('modules: full graph imports (index + bridge + adapters)', async () => {
  const idx = await import('../lib/index.js')
  assert.equal(idx.name, 'messaging-bridge')
  assert.ok(Array.isArray(idx.inject) && idx.inject.includes('agents'))
  assert.equal(typeof idx.apply, 'function')
  assert.equal(typeof idx.Config, 'function')
  const { createBridge } = await import('../lib/bridge.js')
  assert.equal(typeof createBridge, 'function')
  const ADAPTER_EXPORTS = { telegram: 'createTelegramAdapter', line: 'createLineAdapter', whatsapp: 'createWhatsAppAdapter' }
  for (const [p, fn] of Object.entries(ADAPTER_EXPORTS)) {
    const m = await import(`../lib/adapters/${p}.js`)
    assert.equal(typeof m[fn], 'function', `${p} adapter export`)
  }
})

// ---- client bundle ----
await t('client: registers via __ModuleLoader__ and exports apply/inject', async () => {
  const captured = {}
  globalThis.window = { __ModuleLoader__: { load: (def) => { captured.def = def } } }
  await import('../lib/client.js')
  assert.equal(captured.def.id, 'dsh-plugin-messaging')
  const fakeReact = { createElement: () => null, useState: () => [undefined, () => {}], useEffect: () => {}, useCallback: (f) => f, useRef: () => ({ current: undefined }) }
  const ex = captured.def.factory((name) => { if (name === 'react') return fakeReact; throw new Error('unexpected require: ' + name) })
  assert.equal(typeof ex.apply, 'function')
  // Client reads config through the Host settings remote (ctx.remote.settings),
  // NOT connection.api — the client `api` object has no `settings` namespace.
  assert.ok(ex.inject.includes('slots') && ex.inject.includes('remote') && ex.inject.includes('remote.settings'))
  assert.ok(!ex.inject.includes('connection'))
  let registered
  const fakeSettings = { describe: async () => ({ ok: true, value: { namespaces: [], writable: true } }), mutate: async () => ({ ok: true, value: {} }) }
  ex.apply({
    remote: { settings: fakeSettings },
    slots: { inject: (_name, fn) => fn(), register: (spec) => { registered = spec } },
  })
  assert.equal(registered.name, 'settings.section')
  assert.equal(registered.id, 'messaging')
  assert.deepEqual(registered.inject(), { settings: fakeSettings })

  // Write path: diffOps recurses containers (never sets a whole non-volatile
  // object) and guards secrets so a blank field never wipes a stored token.
  const { diffOps, isSecretPath } = ex.__internals
  assert.ok(isSecretPath(['telegram', 'botToken']) && isSecretPath(['line', 'channelSecret']))
  assert.ok(!isSecretPath(['telegram', 'receiveMode']) && !isSecretPath(['wa', 'verifyToken']))
  assert.deepEqual(diffOps({}, { telegram: { botToken: 'TOK' } }, [], isSecretPath),
    [{ op: 'set', path: ['telegram', 'botToken'], value: 'TOK' }], 'typed secret -> set')
  assert.deepEqual(diffOps({}, { telegram: { botToken: '' } }, [], isSecretPath), [], 'blank secret -> skipped')
  assert.deepEqual(diffOps({}, { line: { allowedGroupIds: ['g1'] } }, [], isSecretPath),
    [{ op: 'set', path: ['line', 'allowedGroupIds'], value: ['g1'] }], 'nested leaf, not whole object')
  assert.deepEqual(diffOps({ publicBaseUrl: 'http://x' }, { publicBaseUrl: '' }, [], isSecretPath),
    [{ op: 'set', path: ['publicBaseUrl'], value: '' }], 'non-secret empty -> clears')
  assert.deepEqual(diffOps({ enabled: true }, { enabled: true }, [], isSecretPath), [], 'unchanged -> no op')
  delete globalThis.window
})

// ---- config ----
await t('config: resolveConfig({}) fills defaults', () => {
  const c = resolveConfig({})
  assert.equal(c.platform, 'line')
  assert.equal(c.replyLanguage, 'en')
  assert.equal(c.translateBackend, 'google')
  assert.equal(c.maxCharsPerMessage, 1800)
  assert.equal(c.line.webhookPath, '/plugins/messaging/line/webhook')
  assert.equal(c.telegram.receiveMode, 'longpoll')
  assert.equal(c.wa.webhookPath, '/plugins/messaging/whatsapp/webhook')
})
await t('config: resolveConfig merges nested + language', () => {
  const c = resolveConfig({ platform: 'telegram', replyLanguage: 'th', telegram: { botToken: 'x', allowedUserIds: ['9'] } })
  assert.equal(c.platform, 'telegram')
  assert.equal(c.replyLanguage, 'th')
  assert.equal(c.telegram.botToken, 'x')
  assert.deepEqual(c.telegram.allowedUserIds, ['9'])
  assert.equal(c.telegram.receiveMode, 'longpoll', 'nested default kept')
})
await t('config: editable leaves are volatile, secrets are role(secret)', () => {
  const d = Config.dict
  // Top-level editable leaves must be volatile so the settings seam exposes them.
  for (const k of ['enabled', 'platform', 'replyLanguage', 'translateBackend', 'maxCharsPerMessage', 'counterEnabled']) {
    assert.equal(d[k].meta.volatile, true, `${k} volatile`)
  }
  // Nested containers are NOT volatile; their editable leaves are.
  assert.ok(!d.line.meta.volatile, 'line container not volatile')
  assert.equal(d.line.dict.allowedGroupIds.meta.volatile, true)
  assert.equal(d.telegram.dict.receiveMode.meta.volatile, true)
  assert.equal(d.wa.dict.phoneNumberId.meta.volatile, true)
  // Secrets carry role('secret') so remote describe() redacts them.
  assert.equal(d.line.dict.channelAccessToken.meta.role, 'secret')
  assert.equal(d.line.dict.channelSecret.meta.role, 'secret')
  assert.equal(d.telegram.dict.botToken.meta.role, 'secret')
  assert.equal(d.wa.dict.accessToken.meta.role, 'secret')
  assert.equal(d.wa.dict.appSecret.meta.role, 'secret')
  // Non-secret leaves must NOT be marked secret (matches the client's field table).
  assert.notEqual(d.wa.dict.verifyToken.meta.role, 'secret')
  assert.notEqual(d.line.dict.channelAccessTokenEnv.meta.role, 'secret')
})
await t('config: resolveConfig unwraps live Volatile refs (cordis apply input)', () => {
  // Simulate the live config cordis hands apply(): volatile leaves are Volatile refs.
  const live = Config({ platform: 'telegram', replyLanguage: 'th', telegram: { botToken: 'TOK', allowedChatIds: ['1'] } })
  assert.equal(typeof live.platform.get, 'function', 'top-level leaf is a ref')
  assert.equal(typeof live.telegram.botToken.get, 'function', 'nested leaf is a ref')
  assert.notEqual(typeof live.telegram.get, 'function', 'container is NOT a ref')
  const c = resolveConfig(live)
  assert.equal(c.platform, 'telegram')
  assert.equal(c.replyLanguage, 'th')
  assert.equal(c.telegram.botToken, 'TOK')
  assert.deepEqual(c.telegram.allowedChatIds, ['1'])
  assert.equal(c.telegram.receiveMode, 'longpoll', 'unconfigured nested default kept')
  assert.equal(c.line.webhookPath, '/plugins/messaging/line/webhook', 'untouched sub-object defaults')
})
await t('telegram adapter: allowlist matches numeric id AND username (@optional, case-insensitive)', async () => {
  const { createTelegramAdapter } = await import('../lib/adapters/telegram.js')
  const seen = []
  const bridge = { onInbound: (ev) => seen.push(ev) }
  const cfg = resolveConfig({ telegram: { botToken: 'X', allowedUserIds: ['@SuperKTH', '999'] } })
  let updates = [
    { update_id: 1, message: { message_id: 1, text: 'hi', from: { id: 111, username: 'superkth' }, chat: { id: 111, type: 'private' } } },
    { update_id: 2, message: { message_id: 2, text: 'yo', from: { id: 999, username: 'someone' }, chat: { id: 999, type: 'private' } } },
    { update_id: 3, message: { message_id: 3, text: 'nope', from: { id: 555, username: 'intruder' }, chat: { id: 555, type: 'private' } } },
  ]
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    // Yield to the macrotask queue each call so the poll loop can't starve the
    // wait-loop timer (real getUpdates is a network call, so this never bites prod).
    await new Promise((r) => setTimeout(r, 0))
    const u = String(url)
    if (u.includes('getUpdates')) { const batch = updates; updates = []; return { json: async () => ({ ok: true, result: batch }) } }
    return { json: async () => ({ ok: true }) }
  }
  let adapter
  try {
    adapter = createTelegramAdapter(cfg, { bridge, log: () => {} })
    await adapter.start()
    const t0 = Date.now()
    while (seen.length < 2 && Date.now() - t0 < 1500) await new Promise((r) => setTimeout(r, 10))
    assert.deepEqual(seen.map((e) => e.userId).sort(), ['111', '999'], 'username-match + id-match allowed, intruder dropped')
  } finally {
    if (adapter) await adapter.stop()
    globalThis.fetch = realFetch
  }
})
await t('telegram adapter: group chat id matches sign-insensitively (config positive, telegram negative)', async () => {
  const { createTelegramAdapter } = await import('../lib/adapters/telegram.js')
  const seen = []
  const bridge = { onInbound: (ev) => seen.push(ev) }
  // Config lists the POSITIVE group id; Telegram actually delivers the NEGATIVE one.
  const cfg = resolveConfig({ telegram: { botToken: 'X', allowedUserIds: ['6236408940'], allowedChatIds: ['1003478007355'] } })
  let updates = [
    { update_id: 1, message: { message_id: 1, text: 'group hi', from: { id: 6236408940, username: 'SuperKTH' }, chat: { id: -1003478007355, type: 'supergroup' } } },
    { update_id: 2, message: { message_id: 2, text: 'other group', from: { id: 6236408940, username: 'SuperKTH' }, chat: { id: -1009999999999, type: 'supergroup' } } },
  ]
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    await new Promise((r) => setTimeout(r, 0))
    const u = String(url)
    if (u.includes('getUpdates')) { const b = updates; updates = []; return { json: async () => ({ ok: true, result: b }) } }
    return { json: async () => ({ ok: true }) }
  }
  let adapter
  try {
    adapter = createTelegramAdapter(cfg, { bridge, log: () => {} })
    await adapter.start()
    const t0 = Date.now()
    while (seen.length < 1 && Date.now() - t0 < 1500) await new Promise((r) => setTimeout(r, 10))
    await new Promise((r) => setTimeout(r, 60)) // let the disallowed group be processed too
    assert.equal(seen.length, 1, 'only the allowlisted group passes')
    assert.equal(seen[0]?.chatId, '-1003478007355', 'negative telegram id accepted against positive config')
    assert.equal(seen[0]?.isGroup, true, 'flagged as group')
  } finally {
    if (adapter) await adapter.stop()
    globalThis.fetch = realFetch
  }
})
await t('bridge: awaits async startStatus (no status.replace crash) AND mounts default preset (tools)', async () => {
  const { createBridge } = await import('../lib/bridge.js')
  const mounted = []
  let ranSetup = false
  const makeAgent = () => {
    const events = []
    let seq = 0
    return {
      session: { snapshotEvents: () => events, requestHeader: () => ({ config: {} }) },
      followup: (msg) => {
        const s = msg.source || {}
        events.push({ seq: ++seq, type: 'user/message', data: { source: { platform: s.platform, messageId: s.messageId } } })
        events.push({ seq: ++seq, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Hello from AI' }] } } })
        events.push({ seq: ++seq, type: 'turn/end', data: { reason: { kind: 'end_turn' } } })
      },
      whenIdle: async () => {},
      inject: () => {},
      cancel: () => {},
    }
  }
  const ctx = {
    get: (name) => {
      if (name === 'agentPresets') return { resolve: async (id) => ({ id: id ?? 'deployment-default' }), mount: async (_c, id) => { mounted.push(id) } }
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'p', model: 'm' }) }
      if (name === 'sessions') return { flush: async () => {} }
      if (name === 'sessionTitle') return { rename: () => {} }
      return undefined
    },
    agents: {
      create: async (opts) => {
        const agent = makeAgent()
        if (opts.setup) { ranSetup = true; await opts.setup({}, agent) } // the host runs setup, which mounts the preset
        return { agent }
      },
      get: () => undefined,
      resume: async () => { throw new Error('no resume in test') },
    },
  }
  const cfg = resolveConfig({ enabled: true, platform: 'telegram', replyLanguage: 'en', translateBackend: 'off', counterEnabled: false, showStatsFooter: false })
  const store = new BindingStore(join(tmp, 'b-state.json'), () => {})
  const counter = new MonthlyCounter(join(tmp, 'b-counter.json'), () => {})
  const translator = createTranslator({ backend: 'off', cacheFile: join(tmp, 'b-tr.json') })
  const bridge = createBridge({ cfg, ctx, store, counter, translator, log: () => {} })

  const replaced = []
  const sent = []
  let statusInitial
  const ev = {
    platform: 'telegram', chatId: '111', userId: '111', text: 'hi', isGroup: false, messageId: 42,
    send: async (chunks) => { sent.push(...chunks); return { kind: 'push' } },
    typing: () => {},
    // async startStatus — the exact shape that used to crash (status was a Promise, not {update,replace,stop})
    startStatus: async (initial) => { statusInitial = initial; return { update: async () => {}, replace: async (x) => { replaced.push(x) }, stop: async () => {} } },
  }
  await bridge.onInbound(ev)
  assert.equal(ranSetup, true, 'agent setup ran (preset-mount path exercised)')
  assert.deepEqual(mounted, ['deployment-default'], 'default preset mounted even with empty config.preset → session has tools')
  assert.equal(typeof statusInitial, 'string', 'thinking status is a string')
  assert.ok(statusInitial.length > 0, 'thinking status sent before the turn')
  assert.deepEqual(replaced, ['Hello from AI'], 'reply delivered via awaited status.replace (no crash)')
  assert.equal(sent.length, 0, 'single chunk edited in place — nothing extra pushed, no error message')
})

await t('telegram adapter: escapes <tags> (never a 400 entity error) and retries as plain text', async () => {
  const { createTelegramAdapter } = await import('../lib/adapters/telegram.js')
  const cfg = resolveConfig({ telegram: { botToken: 'X', allowedUserIds: ['1'] } })
  const posts = []
  let updates = [{ update_id: 1, message: { message_id: 1, text: 'hi', from: { id: 1, username: 'u' }, chat: { id: 1, type: 'private' } } }]
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    await new Promise((r) => setTimeout(r, 0))
    const u = String(url)
    const method = u.slice(u.lastIndexOf('/') + 1).split('?')[0]
    const body = init.body ? JSON.parse(init.body) : {}
    if (method !== 'getUpdates') posts.push({ method, body })
    if (method === 'getUpdates') { const b = updates; updates = []; return { json: async () => ({ ok: true, result: b }) } }
    // Simulate Telegram refusing ANY parsed entity: only a parse_mode-free call passes.
    if (method === 'editMessageText' && body.parse_mode) {
      return { json: async () => ({ ok: false, description: 'Bad Request: can\'t parse entities: Unsupported start tag "token" at byte offset 3' }) }
    }
    if (method === 'sendMessage') return { json: async () => ({ ok: true, result: { message_id: 7 } }) }
    return { json: async () => ({ ok: true }) }
  }
  let ev, adapter
  try {
    adapter = createTelegramAdapter(cfg, { bridge: { onInbound: (e) => { ev = e } }, log: () => {} })
    await adapter.start()
    const t0 = Date.now()
    while (!ev && Date.now() - t0 < 1500) await new Promise((r) => setTimeout(r, 10))
    assert.ok(ev, 'inbound event delivered')

    const sent = await ev.send(['use <token> & <b>x</b>'])
    const msg = posts.find((p) => p.method === 'sendMessage' && /use/.test(p.body.text || ''))
    assert.ok(msg, 'sendMessage issued')
    assert.ok(!msg.body.text.includes('<token>'), 'raw tag never leaves the process')
    assert.ok(msg.body.text.includes('&lt;token&gt;') && msg.body.text.includes('&amp;'), 'escaped for HTML')
    assert.equal(msg.body.parse_mode, 'HTML')
    assert.equal(sent.kind, 'push')

    // Final status replace: entity error must fall back to a parse_mode-free edit
    // carrying the ORIGINAL characters (not literal &lt;), and must not throw.
    const status = await ev.startStatus('thinking')
    await status.replace('literal <token> here')
    const edits = posts.filter((p) => p.method === 'editMessageText')
    assert.ok(edits.some((p) => p.body.parse_mode === 'HTML' && p.body.text.includes('&lt;token&gt;')), 'replace escapes too')
    const plain = edits.find((p) => p.body.parse_mode === undefined)
    assert.ok(plain, 'retried without parse_mode')
    assert.ok(plain.body.text.includes('<token>'), 'plain retry sends the raw characters')
  } finally {
    if (adapter) await adapter.stop()
    globalThis.fetch = realFetch
  }
})

rmSync(tmp, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
