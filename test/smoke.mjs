// smoke.mjs — dependency-free unit tests for the pure modules.
// Run: node ./test/smoke.mjs
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { Readable } from 'node:stream'
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
import { resolveConfig, Config, wantedPlatforms } from '../lib/config.js'

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
await t('chunk: hard limits map', () => {
  assert.equal(HARD_LIMITS.telegram, 4096)
  assert.equal(HARD_LIMITS.whatsapp, 4096)
  assert.equal(HARD_LIMITS.discord, 2000, 'Discord rejects a message over 2000 characters')
  assert.equal(HARD_LIMITS.messenger, 2000, 'Messenger rejects a message over 2000 characters')
})

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
  const ADAPTER_EXPORTS = {
    telegram: 'createTelegramAdapter', line: 'createLineAdapter', whatsapp: 'createWhatsAppAdapter',
    discord: 'createDiscordAdapter', messenger: 'createMessengerAdapter',
  }
  for (const [p, fn] of Object.entries(ADAPTER_EXPORTS)) {
    const m = await import(`../lib/adapters/${p}.js`)
    assert.equal(typeof m[fn], 'function', `${p} adapter export`)
  }
  // deliver.js is the piece every channel's delivery runs through, and it is only
  // unit-testable because it drags nothing in: no cordis, no adapters, no config.
  const deliverSrc = readFileSync(new URL('../lib/deliver.js', import.meta.url), 'utf8')
  assert.ok(!/^\s*import\s/m.test(deliverSrc), 'deliver.js has no imports at all — keep it that way')
  const { deliverChunks } = await import('../lib/deliver.js')
  assert.equal(typeof deliverChunks, 'function')
})

// ---- client bundle ----
// The bundle registers itself with the module loader exactly once (ESM cache), so
// keep the definition around for the language / rendering test below.
let CLIENT_DEF = null
await t('client: registers via __ModuleLoader__ and exports apply/inject', async () => {
  const captured = {}
  globalThis.window = { __ModuleLoader__: { load: (def) => { captured.def = CLIENT_DEF = def } } }
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
  const { diffOps, isSecretPath, PLATFORM_FIELDS } = ex.__internals
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

  // Each channel card is LED by the live "Keep the connection open" box, and that
  // box saves itself (immediate) because the bridge reacts without a restart.
  for (const p of ['line', 'telegram', 'whatsapp', 'discord', 'messenger']) {
    const f = (PLATFORM_FIELDS[p] || [])[0]
    assert.ok(f && f.check === true && f.label === 'Keep the connection open', `${p} leads with the keep-open box`)
    assert.equal(f.immediate, true, `${p} saves on toggle`)
    assert.ok(typeof f.hint === 'string' && f.hint.includes('มีผลทันที'), `${p} hint says live`)
  }
  assert.deepEqual(PLATFORM_FIELDS.line[0].path, ['line', 'keepOpen'])
  assert.deepEqual(PLATFORM_FIELDS.telegram[0].path, ['telegram', 'keepOpen'])
  assert.deepEqual(PLATFORM_FIELDS.whatsapp[0].path, ['wa', 'keepOpen'], 'whatsapp writes the wa config key')
  assert.deepEqual(PLATFORM_FIELDS.discord[0].path, ['discord', 'keepOpen'])
  assert.deepEqual(PLATFORM_FIELDS.messenger[0].path, ['messenger', 'keepOpen'])
  // Every field the settings page can touch must exist in the server Config, and the
  // secret boxes must line up with the schema's role('secret') leaves exactly.
  for (const [p, rows] of Object.entries(PLATFORM_FIELDS)) {
    for (const f of rows) {
      assert.ok(Array.isArray(f.path) && f.path.length === 2, `${p}.${f.label} has a two-part path`)
      assert.equal(isSecretPath(f.path), !!f.secret, `${p}: secret flag matches the schema for ${f.path.join('.')}`)
    }
  }
  delete globalThis.window
})

// ---- page language ----
// The 🌐 menu is `replyLanguage`, and the whole settings page is drawn from it:
// picking a language must repaint every label, hint and button (nothing may stay
// in the previous language), and it must do so without a restart.
const THAI = /[฀-๿]/
const HAN = /[一-鿿]/
const collect = (node, acc = { texts: [], selects: [] }) => {
  if (node == null || node === true || node === false) return acc
  if (Array.isArray(node)) { for (const n of node) collect(n, acc); return acc }
  if (typeof node === 'string') { acc.texts.push(node); return acc }
  if (typeof node !== 'object') return acc
  for (const k of Object.keys(node.props || {})) {
    // `key` and `className` are plumbing, not copy — and a list key holds a raw STR
    // id, which the "no STR id leaks onto the page" check below must not trip over.
    if (k === 'key' || k === 'className') continue
    const v = node.props[k]
    if (typeof v === 'string') acc.texts.push(v)
  }
  if (node.type === 'Select') acc.selects.push(node.props)
  return collect(node.children, acc)
}// Minimal stateful React: useConfig's two useState hooks are pre-seeded (ready +
// draft) so Section renders the full page synchronously; useEffect is a no-op, so
// the async load() never runs and the render is deterministic.
const renderPage = (draft) => {
  const states = [{ status: 'ready', writable: true, saved: false, configured: new Set(['telegram.botToken']) }, draft]
  let i = 0
  const react = {
    createElement: (type, props, ...children) => ({ type: typeof type === 'function' ? (type.name || 'component') : type, props: props || {}, children }),
    useState: (init) => { const k = i++; if (!(k in states)) states[k] = typeof init === 'function' ? init() : init; return [states[k], () => {}] },
    useEffect: () => {},
    useCallback: (f) => f,
    useRef: (v) => ({ current: v }),
  }
  const api = CLIENT_DEF.factory((n) => { if (n === 'react') return react; throw new Error('unexpected require: ' + n) })
  const settings = { describe: async () => ({ ok: true, value: { namespaces: [], writable: true } }), mutate: async () => ({ ok: true, value: {} }) }
  const node = api.__internals.Section({ settings })
  const acc = collect(node)
  acc.api = api
  acc.text = acc.texts.join('\n')
  return acc
}
const PAGE = {
  enabled: true, platform: 'line', translateBackend: 'google', maxCharsPerMessage: 1800,
  counterEnabled: true, broadcast: { enabled: true, platforms: ['telegram'], shareSession: false },
}
await t('client: the whole page repaints in the selected language', () => {
  assert.ok(CLIENT_DEF, 'client definition captured by the previous test')
  const en = renderPage({ ...PAGE, replyLanguage: 'en' })
  const th = renderPage({ ...PAGE, replyLanguage: 'th' })
  const zh = renderPage({ ...PAGE, replyLanguage: 'zh' })

  assert.ok(en.text.includes('General') && en.text.includes('Advanced') && en.text.includes('Save') && en.text.includes('Translation engine'), 'english labels')
  assert.ok(th.text.includes('ทั่วไป') && th.text.includes('ขั้นสูง') && th.text.includes('บันทึก'), 'thai labels')
  assert.ok(zh.text.includes('常规') && zh.text.includes('高级') && zh.text.includes('保存'), 'chinese labels')
  // Nothing may leak from another language into the page you are looking at.
  const leak = (label, txt, re, what) => assert.ok(!re.test(txt), `${label} page still contains ${what}: ${JSON.stringify((txt.match(re) || []).slice(0, 4))}`)
  leak('english', en.text, THAI, 'Thai'); leak('english', en.text, HAN, 'Chinese')
  leak('thai', th.text, HAN, 'Chinese')
  leak('chinese', zh.text, THAI, 'Thai')

  // The picker keeps native language names in every locale and shows what you chose.
  const pick = (p) => p.selects.find((s) => (s.options || []).length === 3 && String((s.options[0] || {}).label || '').startsWith('🇬🇧'))
  const lang = pick(en)
  assert.ok(lang, 'language menu rendered as a select')
  assert.ok(lang.options.some((o) => o.label.includes('🇹🇭') && o.label.includes('ไทย')), 'thai option names itself in thai')
  assert.equal(pick(th).value, 'th', 'menu reflects the saved language (th)')
  assert.equal(pick(zh).value, 'zh', 'menu reflects the saved language (zh)')
  assert.equal(lang.value, 'en', 'menu reflects the saved language (en)')

  // translateBackend=off means AI answers are NOT translated — say so, in the
  // language the page is using, and only then.
  const off = renderPage({ ...PAGE, replyLanguage: 'en', translateBackend: 'off' })
  assert.ok(off.text.toLowerCase().includes('translation engine is set to'), 'warns when translation is off')
  assert.ok(!en.text.toLowerCase().includes('translation engine is set to'), 'no warning while translating')
  assert.ok(renderPage({ ...PAGE, replyLanguage: 'th', translateBackend: 'off' }).text.includes('ไม่ถูกแปล'), 'warning follows the page language')
})

await t('client: every UI string exists in all three languages', () => {
  const { STR, platformFields, makeT } = renderPage({ ...PAGE, replyLanguage: 'en' }).api.__internals
  // Rows that are technical product names stay Latin on purpose.
  const LATIN_ONLY = new Set(['keepLabel', 'bcTitle', 'webhookPath', 'accessToken', 'phoneId', 'botToken',
    'lineToken', 'lineTokenPh', 'modeWebhook', 'verifyToken', 'loadingLabel', 'appSecret',
    'pageToken', 'graphVersion'])
  for (const [id, row] of Object.entries(STR)) {
    assert.ok(Array.isArray(row) && row.length === 3, `${id} has a th/en/zh column`)
    row.forEach((s, k) => assert.ok(typeof s === 'string' && s.trim().length > 0, `${id}[${k}] is not empty`))
    assert.ok(!THAI.test(row[1]), `${id} english column must be Thai-free`)
    assert.ok(!THAI.test(row[2]) && !HAN.test(row[1]), `${id} en/zh columns must not mix scripts`)
    if (!LATIN_ONLY.has(id)) assert.ok(THAI.test(row[0]), `${id} thai column should read as Thai`)
  }
  // {n} placeholders survive in every language.
  for (const code of ['th', 'en', 'zh']) {
    const s = makeT(code)('chanSettings', { n: 'LINE' })
    assert.ok(s.includes('LINE') && !s.includes('{n}'), `${code} interpolates the platform name`)
  }
  // The channel field table follows the language too — and the Thai hint keeps the
  // words "มีผลทันที" (applies immediately) the keep-open contract is tested on.
  for (const [p, name] of [['line', 'LINE'], ['telegram', 'Telegram'], ['whatsapp', 'WhatsApp'],
    ['discord', 'Discord'], ['messenger', 'Messenger']]) {
    const enF = platformFields(makeT('en'))[p][0]
    const thF = platformFields(makeT('th'))[p][0]
    const zhF = platformFields(makeT('zh'))[p][0]
    assert.equal(enF.label, 'Keep the connection open', `${p} checkbox keeps its product name`)
    assert.ok(enF.hint.includes(name), `${p} english hint names the channel: ${enF.hint}`)
    assert.ok(!THAI.test(enF.hint) && !HAN.test(enF.hint), `${p} english hint is clean`)
    assert.ok(thF.hint.includes('มีผลทันที'), `${p} thai hint says live`)
    assert.ok(HAN.test(zhF.hint) && !THAI.test(zhF.hint), `${p} chinese hint is Chinese`)
  }
})

await t('client: every string id the page asks for exists in STR', () => {
  const { STR } = renderPage({ ...PAGE, replyLanguage: 'en' }).api.__internals
  const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const used = new Set()
  for (const m of src.matchAll(/\bt\(\s*'([A-Za-z0-9]+)'/g)) used.add(m[1])
  // The per-platform guidance block holds bare string ids that are rendered via t(id).
  const start = src.indexOf('const notes = platform ===')
  assert.ok(start > 0, 'the per-platform notes block is still there')
  const blank = src.indexOf('\n\n', start)
  const block = src.slice(start, blank > start ? blank : start + 600)
  const NOT_KEYS = new Set(['line', 'telegram', 'whatsapp', 'discord', 'messenger'])
  for (const m of block.matchAll(/'([a-z][A-Za-z0-9]*)'/g)) {
    if (!NOT_KEYS.has(m[1]) && !m[1].startsWith('mb_')) used.add(m[1])
  }
  // A typo here is invisible until someone opens that card: t() falls back to
  // printing the id itself, which is exactly what this test prevents.
  const missing = [...used].filter((k) => !STR[k])
  assert.deepEqual(missing, [], `unknown STR ids referenced by the page: ${missing.join(', ')}`)
  assert.ok(used.size > 40, `the scan only found ${used.size} ids — the regex has gone stale`)
})
await t('client: the Discord and Messenger cards render in all three languages', () => {
  const { STR, makeT } = renderPage({ ...PAGE, replyLanguage: 'en' }).api.__internals
  const camel = Object.keys(STR).filter((id) => /[a-z][A-Z]/.test(id) && id.length > 6)
  for (const [p, noteKey] of [['discord', 'discordNote'], ['messenger', 'windowNote']]) {
    for (const code of ['th', 'en', 'zh']) {
      const acc = renderPage({ ...PAGE, platform: p, replyLanguage: code })
      const name = p === 'discord' ? 'Discord' : 'Messenger'
      assert.ok(acc.text.includes(name), `${p}/${code}: the card names its transport`)
      assert.ok(acc.text.includes(makeT(code)(noteKey).slice(0, 24)), `${p}/${code}: ${noteKey} guidance is on the card`)
      assert.ok(acc.text.includes('Keep the connection open'), `${p}/${code}: keep-open box present`)
      if (code === 'en') assert.ok(!THAI.test(acc.text) && !HAN.test(acc.text), `${p}/en: no Thai, no Chinese`)
      if (code === 'th') assert.ok(THAI.test(acc.text) && !HAN.test(acc.text), `${p}/th: Thai, and no Chinese`)
      if (code === 'zh') assert.ok(HAN.test(acc.text) && !THAI.test(acc.text), `${p}/zh: Chinese, and no Thai`)
      // A missing translation prints its own key; English prose never contains CamelCase.
      for (const id of camel) assert.ok(!acc.text.includes(id), `${p}/${code}: STR id "${id}" leaked as text`)
    }
  }
})

// ---- config ----
await t('config: resolveConfig({}) fills defaults', () => {  const c = resolveConfig({})
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
  assert.equal(d.discord.dict.botToken.meta.volatile, true)
  assert.equal(d.messenger.dict.pageAccessToken.meta.volatile, true)
  // Secrets carry role('secret') so remote describe() redacts them.
  assert.equal(d.line.dict.channelAccessToken.meta.role, 'secret')
  assert.equal(d.line.dict.channelSecret.meta.role, 'secret')
  assert.equal(d.telegram.dict.botToken.meta.role, 'secret')
  assert.equal(d.wa.dict.accessToken.meta.role, 'secret')
  assert.equal(d.wa.dict.appSecret.meta.role, 'secret')
  assert.equal(d.discord.dict.botToken.meta.role, 'secret')
  assert.equal(d.messenger.dict.pageAccessToken.meta.role, 'secret')
  assert.equal(d.messenger.dict.appSecret.meta.role, 'secret')
  // Non-secret leaves must NOT be marked secret (matches the client's field table).
  assert.notEqual(d.wa.dict.verifyToken.meta.role, 'secret')
  assert.notEqual(d.line.dict.channelAccessTokenEnv.meta.role, 'secret')
  assert.notEqual(d.discord.dict.gatewayUrl.meta.role, 'secret')
  assert.notEqual(d.messenger.dict.verifyToken.meta.role, 'secret')
  // `platform` accepts all five transports and nothing else.
  for (const p of ['line', 'telegram', 'whatsapp', 'discord', 'messenger']) {
    assert.equal(Config({ platform: p }).platform.get(), p, `${p} is a valid platform`)
  }
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
await t('config: keepOpen defaults off; wantedPlatforms = primary + kept-open channels', () => {
  const c = resolveConfig({})
  assert.equal(c.line.keepOpen, false)
  assert.equal(c.telegram.keepOpen, false)
  assert.equal(c.wa.keepOpen, false)
  assert.equal(c.discord.keepOpen, false)
  assert.equal(c.messenger.keepOpen, false)
  assert.equal(c.discord.botTokenEnv, 'DISCORD_BOT_TOKEN')
  assert.equal(c.messenger.graphVersion, 'v24.0', 'Meta rolls Graph versions on a schedule; the default must be current')
  assert.equal(c.messenger.webhookPath, '/plugins/messaging/messenger/webhook')
  assert.deepEqual(wantedPlatforms(c), ['line'])
  assert.deepEqual(wantedPlatforms(resolveConfig({ platform: 'telegram', line: { keepOpen: true }, wa: { keepOpen: true } })),
    ['telegram', 'line', 'whatsapp'], 'primary first, then each kept-open channel')
  assert.deepEqual(wantedPlatforms(resolveConfig({ platform: 'whatsapp', wa: { keepOpen: true } })),
    ['whatsapp'], 'primary already kept open is not duplicated')
  assert.deepEqual(wantedPlatforms(resolveConfig({ platform: 'line', broadcast: { enabled: true } })),
    ['line', 'telegram', 'whatsapp', 'discord', 'messenger'], 'broadcast still runs everything')
  assert.deepEqual(wantedPlatforms(resolveConfig({ platform: 'discord', messenger: { keepOpen: true } })),
    ['discord', 'messenger'], 'the two newest channels follow the same keep-open rule')
})
await t('config: resolved view reads THROUGH the live refs, so a save lands without a restart', () => {
  // Stand-in for the Volatile refs cordis owns: .get() always returns the current
  // value, and the loader commits a settings save by swapping that value in place.
  const ref = (v) => ({ get: () => v, set(next) { v = next } })
  const live = {
    enabled: ref(true),
    platform: ref('telegram'),
    replyLanguage: ref('en'),
    telegram: { keepOpen: ref(false) },
    broadcast: { enabled: ref(false) },
  }
  const cfg = resolveConfig(live)
  assert.equal(cfg.replyLanguage, 'en')
  assert.deepEqual(wantedPlatforms(cfg), ['telegram'])
  live.replyLanguage.set('th')
  live.telegram.keepOpen.set(true)
  assert.equal(cfg.replyLanguage, 'th', 'language picked in the settings page applies to the running bridge')
  assert.equal(cfg.telegram.keepOpen, true)
  assert.equal(cfg.wa.keepOpen, false, 'a channel the host never sent keeps its default')
  assert.deepEqual(wantedPlatforms(cfg), ['telegram'], 'a channel kept open that is already primary is not duplicated')
  live.wa = { keepOpen: ref(true) }
  assert.deepEqual(wantedPlatforms(cfg), ['telegram', 'whatsapp'], 'a sub-object the host starts sending is picked up too')
  live.broadcast.enabled.set(true)
  assert.deepEqual(wantedPlatforms(cfg), ['line', 'telegram', 'whatsapp', 'discord', 'messenger'], 'broadcast flip is live too')
  // A plain object (tests, hand-written config) stays a plain snapshot.
  const plain = resolveConfig({ replyLanguage: 'zh' })
  assert.equal(plain.replyLanguage, 'zh')
  assert.deepEqual(Object.keys(JSON.parse(JSON.stringify(plain))).length > 10, true, 'serializable')
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

await t('commands: /access and /tools parse (aliases included)', () => {
  assert.deepEqual(parseCommand('/access full'), { type: 'access', arg: 'full' })
  assert.deepEqual(parseCommand('/perm'), { type: 'access', arg: '' })
  assert.deepEqual(parseCommand('/tools'), { type: 'tools', arg: '' })
  assert.deepEqual(parseCommand('/mcp laya off'), { type: 'tools', arg: 'laya off' })
})

await t('permissions: aliases map onto presets; knobs written through both services', async () => {
  const { ACCESS_LEVELS, accessLevel, accessSupported, accessState, applyAccess, permissionService, approvalService } = await import('../lib/permissions.js')
  assert.deepEqual(ACCESS_LEVELS.map((l) => l.preset), ['read-only', 'workspace-write', 'danger-full-access'], 'the three dsh-base presets')
  assert.equal(accessLevel('FULL')?.preset, 'danger-full-access')
  assert.equal(accessLevel(' w ')?.preset, 'workspace-write')
  assert.equal(accessLevel('ro')?.key, 'read')
  assert.equal(accessLevel('banana'), null)

  const PRESETS = { 'read-only': ['read-only', 'ask'], 'workspace-write': ['workspace-write', 'ask'], 'danger-full-access': ['danger-full-access', 'never'] }
  const kn = { sandbox: 'workspace-write', approval: 'ask' }
  const notified = []
  const pp = {
    names: Object.keys(PRESETS),
    permissionState: () => ({ ...kn }),
    current: () => Object.keys(PRESETS).find((n) => PRESETS[n][0] === kn.sandbox && PRESETS[n][1] === kn.approval) ?? 'custom',
    apply: (_s, name, setApproval) => {
      const [sb, ap] = PRESETS[name]
      kn.sandbox = sb
      if (ap !== kn.approval) setApproval(ap)
      kn.approval = ap
    },
    set: (_s, name) => { const [sb, ap] = PRESETS[name]; kn.sandbox = sb; kn.approval = ap },
  }
  const approval = { config: { policy: 'ask' }, setPolicy: (_a, p) => { notified.push(p) } }
  const ctx = { get: (n) => (n === 'permissionPresets' ? pp : n === 'approval' ? approval : n === 'shell' ? { sandboxMode: 'workspace-write' } : undefined) }
  assert.equal(permissionService(ctx), pp, 'service resolves under its camelCase key')
  assert.equal(approvalService(ctx), approval)
  assert.equal(accessSupported(pp, accessLevel('full')), true)
  assert.equal(accessSupported({ names: ['safe-only'] }, accessLevel('full')), false, 'renamed catalog cannot be escalated to')

  const st = applyAccess(pp, approval, ctx, { session: {} }, accessLevel('full'))
  assert.deepEqual([kn.sandbox, kn.approval], ['danger-full-access', 'never'])
  assert.deepEqual(notified, ['never'], 'approval knob goes through the approval service (live agent notified now)')
  assert.equal(st.preset, 'danger-full-access')
  assert.equal(accessState(pp, ctx, { session: {} }).sandbox, 'danger-full-access')
  assert.equal(applyAccess(pp, null, ctx, { session: {} }, accessLevel('read')).preset, 'read-only', 'no approval service → durable setter path')
  assert.equal(permissionService({ get: () => undefined }), null, 'host without the service degrades instead of throwing')
})

await t('mcpctl: loopback manager calls, row-id toggle, builtin refusal', async () => {
  const { mcpList, mcpSet, matchServer } = await import('../lib/mcpctl.js')
  const servers = [
    { id: 'mcp-laya', serverName: 'laya', source: 'user', enabled: true, live: { toolCount: 3 } },
    { id: 'mcp-mcp-comfy', serverName: 'mcp-comfy', source: 'user', enabled: false, live: { toolCount: 0 } },
    { id: '', serverName: 'computer-use', source: 'builtin', enabled: true, live: { toolCount: 1 } },
  ]
  const calls = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url)
    calls.push({ u, init })
    if (u.includes('/servers')) return { ok: true, status: 200, text: async () => JSON.stringify({ servers }) }
    if (u.includes('/toggle')) {
      const body = JSON.parse(init.body)
      // The real manager re-reads the patch it just wrote, so the next list
      // reflects the toggle — mutate the fixture the same way.
      for (const s of servers) if (s.id === body.id) s.enabled = body.enabled === true
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, action: body.enabled ? 'enabled' : 'disabled' }) }
    }
    return { ok: false, status: 404, text: async () => JSON.stringify({ error: 'nope' }) }
  }
  const ctx = { get: (n) => (n === 'webServer' ? { port: 3080 } : undefined) }
  try {
    assert.equal((await mcpList(ctx)).length, 3)
    assert.equal(calls[0].u, 'http://127.0.0.1:3080/mcp-manager-plus/servers?lang=en', 'same-host loopback URL')
    assert.deepEqual(await mcpSet(ctx, 'laya', false), { name: 'laya', action: 'disabled' })
    const toggleCall = calls.find((c) => c.u.endsWith('/toggle'))
    assert.deepEqual(JSON.parse(toggleCall.init.body), { id: 'mcp-laya', enabled: false }, 'toggle addresses the patch ROW ID')
    assert.equal(toggleCall.init.method, 'POST')
    assert.equal((await mcpSet(ctx, 'comfy', true)).action, 'enabled', 'unique substring resolves')
    assert.equal((await mcpSet(ctx, 'laya', false)).unchanged, true, 'already off → no write')
    assert.equal((await mcpSet(ctx, 'computer', true)).builtin, true, 'built-in providers are refused')
    const miss = await mcpSet(ctx, 'banana', true)
    assert.equal(miss.missing, true)
    assert.ok(miss.known.includes('laya'), 'known names come back for the reply')
    await assert.rejects(() => mcpSet({ get: () => undefined }, 'laya', false), /not listening/, 'no webServer port → clear error')
  } finally {
    globalThis.fetch = realFetch
  }
  assert.equal(matchServer(servers, 'm').ambiguous.length, 2, 'ambiguous matches are reported, not guessed')
})

await t('bridge: /access switches the session, /tools drives the manager, request_access only asks', async () => {
  const { createBridge } = await import('../lib/bridge.js')
  const PRESETS = { 'read-only': ['read-only', 'ask'], 'workspace-write': ['workspace-write', 'ask'], 'danger-full-access': ['danger-full-access', 'never'] }
  const kn = { sandbox: 'read-only', approval: 'ask' }
  const notified = []
  const pp = {
    names: Object.keys(PRESETS),
    permissionState: () => ({ ...kn }),
    current: () => Object.keys(PRESETS).find((n) => PRESETS[n][0] === kn.sandbox && PRESETS[n][1] === kn.approval) ?? 'custom',
    apply: (_s, name, setApproval) => {
      const [sb, ap] = PRESETS[name]
      kn.sandbox = sb
      if (ap !== kn.approval) setApproval(ap)
      kn.approval = ap
    },
    set: (_s, name) => { const [sb, ap] = PRESETS[name]; kn.sandbox = sb; kn.approval = ap },
  }
  const servers = [{ id: 'mcp-laya', serverName: 'laya', source: 'user', enabled: true, live: { toolCount: 3 } }]
  const http = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url)
    http.push({ u, init })
    if (u.includes('/toggle')) http.push({ toggled: JSON.parse(init.body) })
    if (u.includes('/servers')) return { ok: true, status: 200, text: async () => JSON.stringify({ servers }) }
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, action: 'disabled' }) }
  }
  const tools = []
  const pushes = []
  const makeAgent = () => {
    const events = []
    let seq = 0
    return {
      session: { id: 'session-access-test', snapshotEvents: () => events, requestHeader: () => ({ config: {} }) },
      followup: (msg) => {
        const s = msg.source || {}
        events.push({ seq: ++seq, type: 'user/message', data: { source: { platform: s.platform, messageId: s.messageId } } })
        events.push({ seq: ++seq, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'ok' }] } } })
        events.push({ seq: ++seq, type: 'turn/end', data: { reason: { kind: 'end_turn' } } })
      },
      whenIdle: async () => {}, inject: () => {}, cancel: () => {},
    }
  }
  const agent = makeAgent()
  const ctx = {
    get: (name) => {
      if (name === 'permissionPresets') return pp
      if (name === 'approval') return { config: { policy: 'ask' }, setPolicy: (_a, p) => notified.push(p) }
      if (name === 'shell') return { sandboxMode: 'read-only' }
      if (name === 'webServer') return { port: 3080 }
      if (name === 'agentPresets') return { resolve: async (id) => ({ id: id ?? 'default' }), mount: async () => {} }
      if (name === 'agentDefaultModel') return { currentSelection: () => ({}) }
      if (name === 'sessions') return { flush: async () => {} }
      if (name === 'sessionTitle') return { rename: () => {} }
      return undefined
    },
    agents: {
      create: async (opts) => { if (opts.setup) await opts.setup({ tools: { register: (d) => tools.push(d) } }, agent); return { agent } },
      get: () => agent,
      resume: async () => { throw new Error('no resume in test') },
    },
  }
  const cfg = resolveConfig({ enabled: true, platform: 'telegram', replyLanguage: 'en', translateBackend: 'off', counterEnabled: false, showStatsFooter: false })
  const store = new BindingStore(join(tmp, 'acc-state.json'), () => {})
  const counter = new MonthlyCounter(join(tmp, 'acc-counter.json'), () => {})
  const translator = createTranslator({ backend: 'off', cacheFile: join(tmp, 'acc-tr.json') })
  const bridge = createBridge({
    cfg, ctx, store, counter, translator, log: () => {},
    adapters: { telegram: { send: async (chatId, chunks) => pushes.push({ chatId, chunks }) } },
  })
  const sent = []
  const say = async (text, messageId) => {
    sent.length = 0
    await bridge.onInbound({
      platform: 'telegram', chatId: '555', userId: '555', text, isGroup: false, messageId,
      send: async (chunks) => { sent.push(...chunks); return { kind: 'push' } },
      typing: () => {},
    })
    return sent.join('\n')
  }
  try {
    // A normal turn primes the session AND registers the scoped tool on it.
    await say('hello', 1)
    assert.equal(tools.length, 1, 'one scoped tool registered')
    const tool = tools[0]
    assert.equal(tool.name, 'request_access')
    assert.deepEqual(tool.parameters.properties.level.enum, ['read', 'write', 'full'])
    assert.ok(typeof tool.output.render === 'function' && typeof tool.execute === 'function')

    // The AI asks: a message lands in the chat, and NO knob moves.
    const asked = await tool.execute({ level: 'write', reason: 'need to write the report file' }, { agent })
    assert.equal(asked.sent, true)
    assert.equal(pushes.length, 1, 'pushed into the chat that drives this session')
    assert.equal(pushes[0].chatId, '555')
    assert.ok(pushes[0].chunks[0].includes('/access write'), 'the ask carries the granting command')
    assert.ok(pushes[0].chunks[0].includes('need to write the report file'), 'the model reason is shown verbatim')
    assert.deepEqual([kn.sandbox, kn.approval], ['read-only', 'ask'], 'asking never escalates anything')

    // The user grants it by hand.
    const granted = await say('/access write', 2)
    assert.ok(granted.includes('Access = write'), granted)
    assert.deepEqual([kn.sandbox, kn.approval], ['workspace-write', 'ask'])
    assert.deepEqual(notified, [], 'no approval-knob change was needed (ask → ask)')
    assert.ok((await say('/access', 3)).includes('workspace-write'), 'bare /access reports the state')
    assert.ok((await say('/access banana', 4)).includes('/access write'), 'bad level shows usage')

    // /tools: list, then toggle through the manager API.
    const list = await say('/tools', 5)
    assert.ok(list.includes('laya') && list.includes('✅'), list)
    const off = await say('/tools laya off', 6)
    assert.ok(off.includes('laya') && off.includes('disabled'), off)
    const toggle = http.find((c) => c.toggled)
    assert.deepEqual(toggle.toggled, { id: 'mcp-laya', enabled: false }, 'toggle posts the row id + a real boolean')
    assert.ok((await say('/tools banana on', 7)).includes('laya'), 'unknown name lists what exists')
    assert.ok((await say('/tools off', 8)).includes('/tools <name>'), 'flag without a name shows usage')
  } finally {
    globalThis.fetch = realFetch
  }
})

await t('index: keepOpen opens that channel on save and closes it again — no restart', async () => {
  const { apply } = await import('../lib/index.js')
  const ref = (v) => ({ get: () => v, set(next) { v = next } })
  const live = {
    enabled: ref(true),
    platform: ref('line'),
    replyLanguage: ref('en'),
    translateBackend: ref('off'),
    stateFile: ref(join(tmp, 'idx-state.json')),
    counterFile: ref(join(tmp, 'idx-counter.json')),
    line: { channelAccessToken: ref('LTOK'), channelSecret: ref('LSECRET'), webhookPath: ref('/plugins/messaging/line/webhook') },
    // botTokenEnv points at a variable that cannot exist, so an empty token really
    // means "idle" no matter what the machine running the tests has exported.
    telegram: { botToken: ref(''), botTokenEnv: ref('DSH_TEST_NO_TELEGRAM_TOKEN'), keepOpen: ref(false) },
    wa: { accessToken: ref(''), accessTokenEnv: ref('DSH_TEST_NO_WA_TOKEN'), phoneNumberId: ref('') },
    broadcast: { enabled: ref(false) },
  }
  const routes = []
  const handlers = []
  let cleanup
  const ctx = {
    baseUrl: 'file:///' + join(tmp, 'idx').replace(/\\/g, '/'),
    logger: { info: () => {}, warn: () => {} },
    get: (name) => {
      if (name === 'loader') return { await: async () => {} }
      if (name === 'webServer') return { register: (r) => { routes.push(r.path); return () => { const i = routes.indexOf(r.path); if (i >= 0) routes.splice(i, 1) } } }
      return undefined
    },
    on: (_event, fn) => { handlers.push(fn) },
    effect: (fn) => { cleanup = fn() },
  }
  const lines = []
  const realLog = console.log
  const realWarn = console.warn
  console.log = (...a) => lines.push(a.join(' '))
  console.warn = (...a) => lines.push(String(a[0]))
  const say = (paths) => handlers.forEach((fn) => fn(paths))
  const has = (needle) => lines.filter((l) => l.includes(needle)).length
  const settle = async (needle, expect = 1) => {
    for (let i = 0; i < 50 && has(needle) < expect; i++) await new Promise((r) => setTimeout(r, 10))
    return has(needle)
  }
  try {
    apply(ctx, live)
    await settle('messaging-bridge listening')
    assert.deepEqual(routes, ['/plugins/messaging/line/webhook'], 'boot opens only the primary channel')
    assert.equal(has('telegram: no bot token'), 0, 'the kept-shut channel is not running')

    // Tick "Keep the connection open" on Telegram, then the settings save commits the
    // volatile value and the loader pokes us — the bridge must open it by itself.
    live.telegram.keepOpen.set(true)
    say([['telegram', 'keepOpen']])
    assert.equal(await settle('telegram: no bot token'), 1, 'telegram opened live (idle here only because it has no token)')

    // An unrelated save (the header language) must not touch any connection.
    live.replyLanguage.set('th')
    say([['replyLanguage']])
    await new Promise((r) => setTimeout(r, 40))
    assert.equal(has('messaging-bridge listening'), 2, 'non-channel config paths are ignored')
    assert.equal(has('telegram: no bot token'), 1, 'and never restart an open channel')

    // Un-tick → close just that channel; the primary keeps its webhook.
    live.telegram.keepOpen.set(false)
    say([['telegram', 'keepOpen']])
    assert.equal(await settle('telegram: connection closed (settings saved)'), 1)
    assert.deepEqual(routes, ['/plugins/messaging/line/webhook'], 'the primary channel stays open')

    // Switching the bridge off in the Settings page is volatile too — it must close
    // the last connection live, and switching it back on must re-open it.
    live.enabled.set(false)
    say([['enabled']])
    for (let i = 0; i < 50 && routes.length; i++) await new Promise((r) => setTimeout(r, 10))
    assert.deepEqual(routes, [], 'un-ticking enabled closes everything, no restart')
    live.enabled.set(true)
    say([['enabled']])
    for (let i = 0; i < 50 && !routes.length; i++) await new Promise((r) => setTimeout(r, 10))
    assert.deepEqual(routes, ['/plugins/messaging/line/webhook'], 'ticking it back opens the primary channel again')

    cleanup()
    assert.deepEqual(routes, [], 'teardown disposes every route we registered')
  } finally {
    console.log = realLog
    console.warn = realWarn
  }
})

// ---- discord ----
// Driving the gateway client with hand-written opcodes covers identify / heartbeat /
// dispatch / resume / intent-downgrade without ever touching discord.com.
class FakeSocket {
  static instances = []
  constructor(url) {
    this.url = url; this.sent = []; this.readyState = 1
    this.onmessage = null; this.onclose = null; this.onerror = null
    FakeSocket.instances.push(this)
  }
  send(data) { this.sent.push(JSON.parse(data)) }
  close(code) { this.readyState = 3; this.onclose?.({ code: code ?? 1006, reason: 'closed by test' }) }
  emit(payload) { this.onmessage?.({ data: JSON.stringify(payload) }) }
  last(op) { return this.sent.filter((p) => p.op === op).pop() }
}

await t('discord gateway: HELLO → identify → READY → MESSAGE_CREATE, resume, 4014, fatal', async () => {
  const { DiscordGateway, INTENTS } = await import('../lib/adapters/discord.js')
  const intents = INTENTS.GUILD_MESSAGES | INTENTS.DIRECT_MESSAGES | INTENTS.MESSAGE_CONTENT
  const ready = []; const msgs = []
  const gw = new DiscordGateway({
    token: 'T', intents,
    hooks: { onReady: (r) => ready.push(r), onMessage: (m) => msgs.push(m), log: () => {} },
    webSocket: FakeSocket,
  })
  FakeSocket.instances.length = 0
  gw.start()
  const ws = FakeSocket.instances[0]
  ws.emit({ op: 10, d: { heartbeat_interval: 45000, url: 'wss://gateway.example' } })
  const id = ws.last(2)
  assert.ok(id, 'identify (op 2) follows HELLO')
  assert.equal(id.d.token, 'T')
  assert.equal(id.d.intents, intents)
  assert.ok(String(id.d.properties.browser).includes('dsh-plugin-messaging'), 'identifies as this plugin')
  ws.emit({ op: 0, t: 'READY', s: 7, d: { user: { id: '424242424242424242' }, session_id: 'S1', resume_gateway_url: 'wss://resume.example' } })
  assert.equal(ready[0].botUserId, '424242424242424242', 'bot id comes from READY (the mention gate needs it)')
  assert.equal(gw.resumeUrl, 'wss://resume.example/?v=10&encoding=json', 'READY moves the reconnect target')
  ws.emit({ op: 0, t: 'MESSAGE_CREATE', s: 8, d: { id: 'm1', channel_id: 'c1', content: 'hi' } })
  ws.emit({ op: 0, t: 'MESSAGE_CREATE', s: 9, d: { id: 'bad' } })
  ws.emit({ op: 0, t: 'GUILD_CREATE', s: 10, d: { id: 'g1' } })
  assert.deepEqual(msgs.map((m) => m.id), ['m1'], 'only a well-formed MESSAGE_CREATE is forwarded')
  assert.equal(gw.lastSeq, 10, 'every dispatch advances the resume seq')
  gw.startHeartbeat(ws, 10)
  await new Promise((r) => setTimeout(r, 45))
  assert.ok(ws.last(1), 'heartbeat (op 1) carries the seq')
  assert.equal(ws.last(1).d, 10)
  gw.stop()
  assert.equal(gw.reconnectTimer, undefined, 'stop clears every timer')

  // Reconnecting with a session id resumes (op 6) instead of re-identifying.
  const gw2 = new DiscordGateway({ token: 'T', intents, hooks: { log: () => {} }, webSocket: FakeSocket })
  gw2.sessionId = 'S9'; gw2.lastSeq = 42
  gw2.start()
  const ws2 = FakeSocket.instances.at(-1)
  ws2.emit({ op: 10, d: { heartbeat_interval: 45000 } })
  assert.deepEqual(ws2.last(6).d, { token: 'T', session_id: 'S9', seq: 42 }, 'op 6 Resume carries session id + last seq')
  assert.equal(ws2.last(2), undefined, 'a resume replaces identify')
  gw2.stop()

  // Close 4014 = disallowed intents: drop MESSAGE_CONTENT once and retry.
  const gw3 = new DiscordGateway({ token: 'T', intents, hooks: { log: () => {} }, webSocket: FakeSocket })
  FakeSocket.instances.length = 0
  gw3.start()
  FakeSocket.instances[0].onclose({ code: 4014, reason: 'disallowed intents' })
  assert.equal(gw3.intents & INTENTS.MESSAGE_CONTENT, 0, 'the privileged intent is dropped, not requested forever')
  assert.ok(gw3.reconnectTimer !== undefined, 'and a reconnect is scheduled instead of dying')
  gw3.stop()

  // An invalid token is terminal — no endless reconnect storm.
  const fatal = []
  const gw4 = new DiscordGateway({ token: 'T', intents, hooks: { onFatal: (r) => fatal.push(r), log: () => {} }, webSocket: FakeSocket })
  FakeSocket.instances.length = 0
  gw4.start()
  FakeSocket.instances[0].onclose({ code: 4004, reason: 'invalid token' })
  assert.equal(fatal.length, 1, 'onFatal fires once')
  assert.ok(/4004/.test(fatal[0]), 'the close code is reported')
  assert.equal(gw4.stopped, true, 'an invalid token does not reconnect forever')
})

await t('discord rest: bot user-agent, allowed_mentions, 429 retry, DM channel, mention strip', async () => {
  const { discordRest, stripBotMentions } = await import('../lib/adapters/discord.js')
  const calls = []
  let rateLimited = 0
  const fetchImpl = async (url, init) => {
    const u = String(url)
    calls.push({ url: u, init })
    if (u.includes('/messages') && rateLimited++ === 0) {
      return { status: 429, ok: false, json: async () => ({ retry_after: 0.01 }), text: async () => '{}' }
    }
    if (u.endsWith('/users/@me')) return { ok: true, status: 200, text: async () => '{"id":"424242424242424242","username":"bridge"}' }
    if (u.endsWith('/users/@me/channels')) return { ok: true, status: 200, text: async () => '{"id":"DMCHAN"}' }
    return { ok: true, status: 200, text: async () => '{"id":"msg1"}' }
  }
  const rest = discordRest({ token: 'T', fetchImpl })
  assert.equal((await rest.getMe()).id, '424242424242424242')
  assert.equal(calls[0].init.headers.authorization, 'Bot T', 'bot token goes in the authorization header')
  assert.ok(/DiscordBot \(/.test(calls[0].init.headers['user-agent']), 'Cloudflare answers 403 without a bot User-Agent')
  await rest.createMessage('c1', 'hello', 'q1')
  const body = JSON.parse(calls.at(-1).init.body)
  assert.deepEqual(body.allowed_mentions, { parse: [] }, 'the bridge never pings anybody')
  assert.deepEqual(body.message_reference, { message_id: 'q1', fail_if_not_exists: false }, 'a reply threads under the question')
  assert.equal(calls.filter((c) => c.url.includes('/messages')).length, 2, 'a 429 is retried after retry_after')
  assert.equal((await rest.createDM('u9')).id, 'DMCHAN')
  assert.equal(stripBotMentions('<@!424242424242424242> /new', '424242424242424242'), '/new', 'the mention is stripped so commands still parse')
  assert.equal(stripBotMentions('hello <@424242424242424242> there', '424242424242424242'), 'hello there', 'a mention anywhere is removed, whitespace stays sane')
  assert.equal(stripBotMentions('<@424242424242424242>', '424242424242424242'), '')
  assert.equal(stripBotMentions('   ', '424242424242424242'), '')
  assert.equal(stripBotMentions('keep <@1234567890> others', '424242424242424242'), 'keep <@1234567890> others', 'other people are left alone')
})

await t('discord adapter: sign-in, mention gate, self/bot/allowlist filters, dedupe, threaded replies, live status', async () => {
  const { createDiscordAdapter } = await import('../lib/adapters/discord.js')
  const cfg = resolveConfig({ discord: { botToken: 'T', allowedUserIds: ['u1'] } })
  const seen = []; const posts = []; const patches = []
  const realFetch = globalThis.fetch
  const realWS = globalThis.WebSocket
  globalThis.fetch = async (url, init) => {
    const u = String(url)
    if (init?.method === 'PATCH') { patches.push(JSON.parse(init.body)); return { ok: true, status: 200, text: async () => '{}' } }
    if (u.endsWith('/users/@me')) return { ok: true, status: 200, text: async () => '{"id":"424242424242424242","username":"bridge"}' }
    const body = JSON.parse(init.body)
    posts.push({ url: u, body })
    return { ok: true, status: 200, text: async () => '{"id":"DMCHAN"}' }
  }
  globalThis.WebSocket = FakeSocket
  let adapter
  try {
    adapter = createDiscordAdapter(cfg, { bridge: { onInbound: (e) => seen.push(e) }, log: () => {} })
    assert.equal(adapter.configured, true)
    FakeSocket.instances.length = 0
    await adapter.start()
    const ws = FakeSocket.instances.at(-1)
    ws.emit({ op: 10, d: { heartbeat_interval: 45000 } })
    ws.emit({ op: 0, t: 'READY', s: 1, d: { user: { id: '424242424242424242' }, session_id: 'S', resume_gateway_url: 'wss://r' } })
    const gm = (o) => ({
      id: o.id, channel_id: 'gc1', guild_id: 'g1', content: o.content ?? 'hello',
      author: o.author ?? { id: 'u1' }, mentions: o.mentions ?? [],
    })
    ws.emit({ op: 0, t: 'MESSAGE_CREATE', s: 2, d: gm({ id: 'a' }) })
    ws.emit({ op: 0, t: 'MESSAGE_CREATE', s: 3, d: gm({ id: 'b', author: { id: '424242424242424242' }, mentions: [{ id: '424242424242424242' }] }) })
    ws.emit({ op: 0, t: 'MESSAGE_CREATE', s: 4, d: gm({ id: 'c', author: { id: 'hacker' }, mentions: [{ id: '424242424242424242' }] }) })
    ws.emit({ op: 0, t: 'MESSAGE_CREATE', s: 5, d: gm({ id: 'd', author: { id: 'u1', bot: true }, mentions: [{ id: '424242424242424242' }] }) })
    ws.emit({ op: 0, t: 'MESSAGE_CREATE', s: 6, d: gm({ id: 'f', content: '   ', mentions: [{ id: '424242424242424242' }] }) })
    await new Promise((r) => setTimeout(r, 20))
    assert.equal(seen.length, 0, 'mention gate, self-messages, allowlist, bots and empty text are all rejected')
    ws.emit({ op: 0, t: 'MESSAGE_CREATE', s: 7, d: gm({ id: 'e', content: '<@!424242424242424242> /status', mentions: [{ id: '424242424242424242' }] }) })
    ws.emit({ op: 0, t: 'MESSAGE_CREATE', s: 7, d: gm({ id: 'e', content: '<@!424242424242424242> /status', mentions: [{ id: '424242424242424242' }] }) })
    await new Promise((r) => setTimeout(r, 20))
    assert.equal(seen.length, 1, 'exactly one inbound; a replayed event is dropped')
    assert.equal(seen[0].platform, 'discord')
    assert.equal(seen[0].chatId, 'gc1')
    assert.equal(seen[0].userId, 'u1')
    assert.equal(seen[0].isGroup, true, 'a guild channel is a group (session title prefix applies)')
    assert.equal(seen[0].text, '/status', 'the bot mention is stripped so commands still parse')
    await seen[0].send(['one', 'two'])
    assert.deepEqual(posts.map((p) => p.body.content), ['one', 'two'])
    assert.equal(posts[0].body.message_reference?.message_id, 'e', 'the first chunk threads under the question')
    assert.equal(posts[1].body.message_reference, undefined, 'the rest are plain sends')
    // A live status is possible because Discord messages are editable.
    const st = await seen[0].startStatus('thinking…')
    await st.update('still thinking')
    assert.equal(patches.length, 0, 'edits are throttled (Discord allows ~5 per 5 s per message)')
    await st.replace('done')
    assert.equal(patches.length, 1, 'the final answer replaces the status in place')
    assert.deepEqual(patches[0], { content: 'done', allowed_mentions: { parse: [] } })
    // Broadcast push: `user:<id>` opens (and caches) a DM channel.
    await adapter.send('user:u2', ['ping'])
    assert.ok(posts.some((p) => p.url.endsWith('/users/@me/channels')), 'a DM channel is opened for user:<id>')
    await adapter.send('user:u2', ['pong'])
    const dmPosts = posts.filter((p) => p.url.includes('/channels/DMCHAN/messages'))
    assert.deepEqual(dmPosts.map((p) => p.body.content), ['ping', 'pong'], 'the DM channel is cached, not re-created')
    assert.equal(posts.filter((p) => p.url.endsWith('/users/@me/channels')).length, 1, 'the DM is opened once')
    await adapter.send('42', ['to a channel'])
    assert.ok(posts.at(-1).url.endsWith('/channels/42/messages'), 'a bare id is a channel id')
  } finally {
    if (adapter) await adapter.stop()
    globalThis.fetch = realFetch
    globalThis.WebSocket = realWS
  }
})

// ---- messenger ----
await t('messenger: X-Hub-Signature-256, webhook body parsing, 24h window error', async () => {
  const { verifyMessengerSignature, parseMessengerBody, isMessengerWindowError, DEFAULT_GRAPH_VERSION } = await import('../lib/adapters/messenger.js')
  assert.equal(DEFAULT_GRAPH_VERSION, 'v24.0', 'Meta rolls Graph versions on a schedule; keep the default current')
  const secret = 'app-secret'
  const body = JSON.stringify({
    object: 'page',
    entry: [{ id: 'PAGE1', messaging: [
      { sender: { id: 'P1' }, timestamp: 1, message: { mid: 'm1', text: 'hello' } },
      { sender: { id: 'P2' }, message: { mid: 'm2', text: 'echo of our own reply', is_echo: true } },
      { sender: { id: 'P3' }, message: { mid: 'm3', text: '   ' } },
      { sender: { id: 'P4' }, message: { mid: 'm4', attachments: [{ type: 'image' }] } },
      { sender: { id: 'P5' }, read: { watermark: 1 } },
      { sender: { id: 'P6' }, message: { mid: 'm6', text: 'blocked sender' } },
    ] }],
  })
  const good = 'sha256=' + createHmac('sha256', secret).update(body, 'utf8').digest('hex')
  assert.ok(verifyMessengerSignature(secret, body, good), 'a valid signature passes')
  assert.ok(!verifyMessengerSignature(secret, body, 'sha256=' + '0'.repeat(64)), 'a forged signature fails')
  assert.ok(!verifyMessengerSignature(secret, body, undefined), 'a missing signature fails')
  assert.ok(!verifyMessengerSignature(secret, body, 'short'), 'a short header cannot panic the compare')
  assert.ok(!verifyMessengerSignature('', body, good), 'no app secret configured = nothing is verifiable, so nothing is accepted (the route is never opened either)')
  const items = parseMessengerBody(JSON.parse(body), { isAllowed: (id) => id !== 'P6' })
  assert.deepEqual(items.map((i) => i.psid), ['P1'], 'echoes, blank text, attachments, read receipts and blocked senders are skipped')
  assert.equal(items[0].text, 'hello')
  assert.equal(items[0].isGroup, false, 'the Send API cannot address Messenger group threads — never claim one')
  assert.deepEqual(parseMessengerBody({}, {}), [], 'a body without entry[] cannot crash the parse')
  assert.ok(isMessengerWindowError(400, '{"error":{"message":"(#10) This message was not delivered because the 24 hour window has passed","code":10,"error_subcode":551}}'), 'the window error is recognised')
  assert.ok(isMessengerWindowError(400, '(#10) The recipient is not available to your app'), 'the "not available" wording too')
  assert.ok(!isMessengerWindowError(200, '{"message_id":"m"}'), 'a send that worked is not a window error')
  assert.ok(!isMessengerWindowError(400, '{"error":{"message":"Invalid OAuth access token","code":190}}'), 'a token error is not a window error')
})

await t('messenger adapter: GET handshake, signed POST, allowlist, typing bubble, MESSAGE_TAG retry', async () => {
  const { createMessengerAdapter } = await import('../lib/adapters/messenger.js')
  const cfg = resolveConfig({
    messenger: {
      pageAccessToken: 'PAT', appSecret: 'SEC', verifyToken: 'VT', pageId: 'PAGE1',
      outOfWindowTag: 'HUMAN_AGENT', allowedUserIds: ['P1'],
    },
  })
  const posts = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : undefined
    posts.push({ url: String(url), body })
    // Every free-form reply is treated as outside the window, so the tag fallback runs.
    if (body?.messaging_type === 'RESPONSE') {
      return { ok: false, status: 400, text: async () => '{"error":{"message":"(#10) This message was not delivered because the 24 hour window has passed","code":10,"error_subcode":551}}' }
    }
    return { ok: true, status: 200, text: async () => '{"message_id":"mid"}' }
  }
  const routes = []
  let handler = null
  const seen = []
  const logs = []
  const ctx = {
    get: (n) => (n === 'webServer'
      ? { register: (r) => { routes.push(r.path); handler = r.handler; return () => routes.splice(routes.indexOf(r.path), 1) } }
      : undefined),
  }
  const mkRes = () => ({ statusCode: 0, chunks: [], end(s) { if (s != null) this.chunks.push(String(s)) } })
  const post = (raw, headers) => new Promise((resolve) => {
    const req = Readable.from([raw])
    req.method = 'POST'; req.url = '/plugins/messaging/messenger/webhook'; req.headers = headers || {}
    const res = mkRes()
    handler(req, res)
    // The handler answers, then parses on the next ticks; give it both.
    setTimeout(() => resolve(res), 30)
  })
  let adapter
  try {
    adapter = createMessengerAdapter(cfg, { bridge: { onInbound: (e) => seen.push(e) }, log: (m) => logs.push(String(m)), ctx })
    assert.equal(adapter.configured, true)
    await adapter.start()
    assert.ok(handler, 'the webhook route was registered at the configured path')
    assert.equal(routes[0], '/plugins/messaging/messenger/webhook')

    // Subscription handshake.
    const okGet = mkRes()
    handler({ method: 'GET', url: '/x?hub.mode=subscribe&hub.verify_token=VT&hub.challenge=1234' }, okGet)
    assert.equal(okGet.statusCode, 200, 'the handshake answers 200')
    assert.equal(okGet.chunks.join(''), '1234', 'and echoes hub.challenge back')
    const badGet = mkRes()
    handler({ method: 'GET', url: '/x?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1' }, badGet)
    assert.equal(badGet.statusCode, 403, 'a wrong verify token is refused')

    // Signature enforcement before anything is parsed.
    const body = JSON.stringify({ object: 'page', entry: [{ id: 'PAGE1', messaging: [
      { sender: { id: 'P1' }, message: { mid: 'm1', text: 'hi there' } },
      { sender: { id: 'P9' }, message: { mid: 'm9', text: 'not on the list' } },
    ] }] })
    const forged = await post(body, { 'x-hub-signature-256': 'sha256=' + 'f'.repeat(64) })
    assert.equal(forged.statusCode, 401, 'a bad X-Hub-Signature-256 is rejected')
    assert.equal(seen.length, 0, 'and nothing reaches the bridge')
    const good = await post(body, { 'x-hub-signature-256': 'sha256=' + createHmac('sha256', 'SEC').update(body, 'utf8').digest('hex') })
    assert.equal(good.statusCode, 200, 'the webhook is acked before the AI turn even starts (Meta retries after 20 s)')
    assert.ok(seen.length === 1, 'only the allowlisted PSID reaches the bridge')
    assert.equal(seen[0].platform, 'messenger')
    assert.equal(seen[0].chatId, 'P1', 'the PSID is the chat id')
    assert.equal(seen[0].text, 'hi there')
    // The same mid twice = a Meta retry, answered once.
    await post(body, { 'x-hub-signature-256': 'sha256=' + createHmac('sha256', 'SEC').update(body, 'utf8').digest('hex') })
    assert.equal(seen.length, 1, 'a retried webhook delivery is deduped by mid')

    // Typing bubble + the window-aware send.
    seen[0].typing()
    await new Promise((r) => setTimeout(r, 10))
    assert.ok(posts.some((p) => p.body?.sender_action === 'typing_on'), 'typing_on is a sender_action, not a message')
    await seen[0].send(['the answer'])
    const sends = posts.filter((p) => p.body?.message)
    assert.deepEqual(sends.map((p) => p.body.messaging_type), ['RESPONSE', 'MESSAGE_TAG'], 'a closed window retries once as a tagged message')
    assert.equal(sends[0].body.recipient.id, 'P1')
    assert.equal(sends[0].body.messaging_type, 'RESPONSE', 'inside the window Meta wants RESPONSE')
    assert.equal(sends[1].body.tag, 'HUMAN_AGENT', 'the configured tag carries the retry')
    assert.equal(sends[1].body.message.text, 'the answer', 'the text is unchanged')
    assert.equal(sends[1].body.message.metadata, 'dsh-messaging-bridge', 'tagged sends are marked as machine traffic')
    assert.ok(posts[0].url.includes('/v24.0/PAGE1/messages'), 'the Graph version and Page id are in the URL')
    assert.ok(posts[0].url.includes('access_token=PAT'), 'the Page token authenticates the call')
    assert.ok(logs.some((l) => /24h window/.test(l)), 'the window problem is explained in the log')
    await adapter.stop()
    assert.deepEqual(routes, [], 'stopping disposes the webhook route')
  } finally {
    if (adapter) await adapter.stop()
    globalThis.fetch = realFetch
  }
})

// ---- delivery (lib/deliver.js) ----
// The bug this guards cost an entire answer: a refused status edit threw on the line
// before ev.send(), so the turn aborted with the reply in hand.
await t('deliver: a live status that refuses to become the answer never swallows the reply', async () => {
  const { deliverChunks } = await import('../lib/deliver.js')
  const logs = []
  const sent = []
  const send = async (chunks) => { sent.push(chunks); return { kind: 'push', sent: chunks.length } }

  // 1 · the edit works: the status IS chunk #1, so only the tail needs a new message.
  const edited = []
  let r = await deliverChunks({
    status: { replace: async (x) => { edited.push(x) } },
    chunks: ['one', 'two', 'three'], send, log: (m) => logs.push(String(m)),
  })
  assert.deepEqual(edited, ['one'], 'the status is edited into the first chunk')
  assert.deepEqual(sent.at(-1), ['two', 'three'], 'only the rest is sent as new messages')
  assert.equal(r.replaced, true)
  assert.equal(r.sent, 3, 'the whole answer counts exactly once')
  // Mixed delivery (head edited in, tail pushed) is reported with the adapter's own
  // kind for the tail: 'push' is the metered one, and billing the lot as a free reply
  // would be the same kind of lie the counter was built to avoid.
  assert.equal(r.kind, 'push', 'what was pushed decides how it is billed')

  // 2 · the edit is refused: everything goes out as a fresh message.
  sent.length = 0
  r = await deliverChunks({
    status: { replace: async () => { throw new Error('editMessageText failed') } },
    chunks: ['one', 'two'], send, log: (m) => logs.push(String(m)),
  })
  assert.deepEqual(sent[0], ['one', 'two'], 'a refused edit sends the WHOLE reply — the user still gets the answer')
  assert.equal(r.sent, 2, 'and nothing is counted twice')
  assert.equal(r.replaced, false, 'it is a push now, because it really is one (the counter bills accordingly)')
  assert.ok(logs.some((l) => /live status could not become the answer/.test(l)), 'the log says what happened')

  // 3 · single-chunk answer on an editable channel: one API call, no extra message.
  sent.length = 0
  r = await deliverChunks({ status: { replace: async () => {} }, chunks: ['only'], send })
  assert.deepEqual(r, { kind: 'reply', sent: 1, replaced: true })
  assert.equal(sent.length, 0, 'nothing was sent at all')

  // 4 · a platform without editable messages (Messenger, LINE) just sends.
  r = await deliverChunks({ chunks: ['a', 'b'], send })
  assert.deepEqual(r, { kind: 'push', sent: 2, replaced: false })

  // 5 · the send itself dies halfway: the error carries what did land.
  const e = await deliverChunks({
    chunks: ['a', 'b', 'c'],
    send: async () => { const err = new Error('graph 503'); err.sent = 1; throw err },
  }).then(() => null, (x) => x)
  assert.ok(e instanceof Error, 'the failure still reaches the caller (the user must be told)')
  assert.equal(e.sent, 1, 'with the honest count of what reached the chat, so a retry cannot double-send')

  // 6 · a head chunk that landed before the tail failed is included in that count.
  const e2 = await deliverChunks({
    status: { replace: async () => {} }, chunks: ['a', 'b'],
    send: async () => { throw new Error('boom') },
  }).then(() => null, (x) => x)
  assert.equal(e2.sent, 1, 'the chunk the status already delivered is not lost from the count')

  // 7 · empty answer: nothing to deliver, nothing to count.
  assert.deepEqual(await deliverChunks({ chunks: [], send }), { kind: 'push', sent: 0, replaced: false })
})

// ---- webhook authentication ----
// Every one of these webhooks used to treat "no secret configured" as "trust the
// body". The body is where the sender identity — the bridge's entire allowlist —
// comes from, so that combination is a login-as-anyone endpoint.
await t('webhooks: an adapter that cannot verify a caller does not open the route at all', async () => {
  const { createLineAdapter } = await import('../lib/adapters/line.js')
  const { createWhatsAppAdapter } = await import('../lib/adapters/whatsapp.js')
  const { createMessengerAdapter } = await import('../lib/adapters/messenger.js')
  const routes = []
  const logs = []
  const ctx = {
    get: (n) => (n === 'webServer'
      ? { register: (rt) => { routes.push(rt.path); return () => { const i = routes.indexOf(rt.path); if (i >= 0) routes.splice(i, 1) } } }
      : undefined),
  }
  const log = (m) => logs.push(String(m))
  // Every *Env points at a variable that cannot exist, so "no secret" here means the
  // same thing on any machine, whatever the CI box happens to have exported.
  const line = createLineAdapter(resolveConfig({
    line: { channelAccessToken: 'LTOK', channelSecretEnv: 'DSH_TEST_NO_LINE_SECRET', webhookPath: '/lh' },
  }), { bridge: {}, log, ctx })
  const wa = createWhatsAppAdapter(resolveConfig({
    wa: { accessToken: 'WTOK', accessTokenEnv: 'DSH_TEST_NO_WA_TOKEN', phoneNumberId: 'PID', appSecretEnv: 'DSH_TEST_NO_WA_SECRET', webhookPath: '/wh' },
  }), { bridge: {}, log, ctx })
  const msg = createMessengerAdapter(resolveConfig({
    messenger: { pageAccessToken: 'MPAT', pageAccessTokenEnv: 'DSH_TEST_NO_MESSENGER_TOKEN', appSecretEnv: 'DSH_TEST_NO_MESSENGER_SECRET', verifyToken: 'VT', pageId: 'PAGE1', webhookPath: '/mh' },
  }), { bridge: {}, log, ctx })

  await line.start(); await wa.start(); await msg.start()
  assert.deepEqual(routes, [], 'no secret, no route — not even one that answers 401 (Meta would mark it verified and stop retrying)')
  assert.equal(logs.filter((l) => /webhook stays closed/.test(l)).length, 3, 'each adapter says out loud why it is shut')
  assert.ok(logs.every((l) => /appSecret|channelSecret|App Secret|channel secret/.test(l) || !/webhook stays closed/.test(l)), 'and points at the field to fill in')

  // The gate must not be a wall: hand it the secret and it behaves exactly as before.
  const line2 = createLineAdapter(resolveConfig({
    line: { channelAccessToken: 'LTOK', channelSecret: 'LSEC', channelSecretEnv: 'DSH_TEST_NO_LINE_SECRET', webhookPath: '/lh' },
  }), { bridge: {}, log, ctx })
  await line2.start()
  assert.deepEqual(routes, ['/lh'], 'with a channel secret the webhook opens as it always did')
  await line2.stop()
})

await t('messenger: a Graph 503 fails the send instead of reporting success', async () => {
  const { createMessengerAdapter } = await import('../lib/adapters/messenger.js')
  const cfg = resolveConfig({
    messenger: {
      pageAccessToken: 'PAT', pageAccessTokenEnv: 'DSH_TEST_NO_MESSENGER_TOKEN_503', appSecret: 'SEC',
      appSecretEnv: 'DSH_TEST_NO_MESSENGER_SECRET_503', pageId: 'PAGE1', allowedUserIds: ['P1'],
    },
  })
  const posts = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : undefined
    posts.push(body?.message?.text)
    if (body?.message?.text === 'two') {
      return { ok: false, status: 503, text: async () => '{"error":{"message":"Service temporarily unavailable","type":"ServiceUnavailableException","code":1,"is_transient":true}}' }
    }
    return { ok: true, status: 200, text: async () => '{"message_id":"mid"}' }
  }
  const logs = []
  // Both outbound paths (the reply ev.send and the broadcast adapter.send) run through
  // the same sendChunks, so the broadcast entry point tests the accounting itself.
  const adapter = createMessengerAdapter(cfg, { bridge: {}, log: (m) => logs.push(String(m)), ctx: { get: () => undefined } })
  try {
    const e = await adapter.send('P1', ['one', 'two', 'three']).then(() => null, (x) => x)
    assert.ok(e instanceof Error, 'a 503 is not a delivered message, so the send must not resolve')
    assert.equal(e.sent, 1, 'only the chunk Meta accepted is counted — a retry will not resend it')
    assert.ok(/503/.test(e.message), 'the Graph status is in the error the operator sees')
    assert.ok(/Service temporarily unavailable/.test(e.message), 'and Meta\u2019s own wording, not just a status code')
    assert.deepEqual(posts, ['one', 'two'], 'it stops at the failure instead of pushing the rest into a broken API')
    assert.deepEqual(await adapter.send('P1', ['one']), { kind: 'push', sent: 1 }, 'a send that works reports what it sent')
  } finally {
    globalThis.fetch = realFetch
  }
})

await t('discord: stop() during sign-in cancels that start — no socket is left running', async () => {
  const { createDiscordAdapter } = await import('../lib/adapters/discord.js')
  const cfg = resolveConfig({ discord: { botToken: 'dtok', botTokenEnv: 'DSH_TEST_NO_DISCORD_TOKEN_RACE' } })
  const realFetch = globalThis.fetch
  const realWS = globalThis.WebSocket
  const logs = []
  let release
  let calls = 0
  globalThis.WebSocket = FakeSocket
  globalThis.fetch = async () => {
    calls++
    // The first getMe() hangs, which is exactly the window the bug lived in.
    if (calls === 1) return { ok: true, status: 200, text: async () => new Promise((resolve) => { release = () => resolve('{"id":"424242424242424242","username":"bridge"}') }) }
    return { ok: true, status: 200, text: async () => '{"id":"424242424242424242","username":"bridge"}' }
  }
  const adapter = createDiscordAdapter(cfg, { bridge: {}, log: (m) => logs.push(String(m)) })
  try {
    FakeSocket.instances.length = 0
    const starting = adapter.start()
    await adapter.stop()          // a settings save lands while getMe() is in flight
    release()
    await starting
    await new Promise((r) => setTimeout(r, 20))
    assert.equal(FakeSocket.instances.length, 0, 'the gateway never opened for an adapter nobody will stop again')
    assert.ok(logs.some((l) => /stopped while signing in/.test(l)), 'the log says the start was cancelled')

    // The guard must not strand a genuine restart.
    await adapter.start()
    assert.equal(FakeSocket.instances.length, 1, 'a later start() still connects')
    FakeSocket.instances[0].emit({ op: 10, d: { heartbeat_interval: 45000 } })
    assert.ok(FakeSocket.instances[0].last(2), 'and identifies normally')
  } finally {
    await adapter.stop()
    globalThis.fetch = realFetch
    globalThis.WebSocket = realWS
  }
})

rmSync(tmp, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
