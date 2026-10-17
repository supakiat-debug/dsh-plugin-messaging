// config.js — schemastery Config schema for the messaging bridge.
// One plugin, one `platform` discriminator; each platform has its own sub-object.
// `replyLanguage` (en default / zh / th) drives the post-reply translation step.
//
// Every editable leaf is marked `.volatile()` so the host settings seam exposes it
// (dsh-settings only surfaces volatile fields — see dsh-free-search for the same
// pattern). Secrets carry `.role('secret')` so the remote describe() redacts them.
// Volatile leaves parse into live `Volatile<T>` references; `resolveConfig` below
// unwraps them (recursively, since our sub-objects are non-volatile containers).

import z from '@deepseek-ai/schemastery'

const lang = z.union([z.const('en'), z.const('zh'), z.const('th')])
const platform = z.union([z.const('line'), z.const('telegram'), z.const('whatsapp'), z.const('discord')])

const lineSchema = z.object({
  channelAccessToken: z.string().role('secret').default('').volatile(),
  channelAccessTokenEnv: z.string().default('LINE_CHANNEL_ACCESS_TOKEN').volatile(),
  channelSecret: z.string().role('secret').default('').volatile(),
  channelSecretEnv: z.string().default('LINE_CHANNEL_SECRET').volatile(),
  allowedUserIds: z.array(String).default([]).volatile(),
  allowedGroupIds: z.array(String).default([]).volatile(),
  allowedRoomIds: z.array(String).default([]).volatile(),
  requireMentionInGroup: z.boolean().default(true).volatile(),
  preferReplyToken: z.boolean().default(true).volatile(),
  webhookPath: z.string().default('/plugins/messaging/line/webhook').volatile(),
})

const telegramSchema = z.object({
  botToken: z.string().role('secret').default('').volatile(),
  botTokenEnv: z.string().default('TELEGRAM_BOT_TOKEN').volatile(),
  receiveMode: z.union([z.const('longpoll'), z.const('webhook')]).default('longpoll').volatile(),
  allowedUserIds: z.array(String).default([]).volatile(),
  allowedChatIds: z.array(String).default([]).volatile(),
  requireMentionInGroup: z.boolean().default(false).volatile(),
  editLiveStatus: z.boolean().default(true).volatile(),
  useRichStreaming: z.boolean().default(true).volatile(),
  webhookPath: z.string().default('/plugins/messaging/telegram/webhook').volatile(),
})

const waSchema = z.object({
  accessToken: z.string().role('secret').default('').volatile(),
  accessTokenEnv: z.string().default('WHATSAPP_ACCESS_TOKEN').volatile(),
  phoneNumberId: z.string().default('').volatile(),
  appSecret: z.string().role('secret').default('').volatile(),
  appSecretEnv: z.string().default('WHATSAPP_APP_SECRET').volatile(),
  verifyToken: z.string().default('').volatile(),
  allowedUserIds: z.array(String).default([]).volatile(),
  allowedGroupIds: z.array(String).default([]).volatile(),
  outOfWindowTemplate: z.string().default('').volatile(),
  webhookPath: z.string().default('/plugins/messaging/whatsapp/webhook').volatile(),
})

const broadcastSchema = z.object({
  // One-way fan-out: copy every AI reply produced on the active platform to the
  // last-known chat of each ticked platform. Enabling it also starts every
  // credential-configured adapter at once, so switching channels needs no restart.
  enabled: z.boolean().default(false).volatile(),
  // shareSession: route inbound from all running platforms into ONE shared session
  // and prefix each prompt with [MSG-<TAG>] so the model knows which channel typed.
  shareSession: z.boolean().default(false).volatile(),
  // Platforms to copy replies TO (targets). The origin platform is always excluded.
  platforms: z.array(String).default([]).volatile(),
})

export const Config = z.object({
  enabled: z.boolean().default(false).volatile(),
  platform: platform.default('line').volatile(),
  // Reply language: translate the stored reply into this language before sending.
  replyLanguage: lang.default('en').volatile(),
  translateBackend: z.union([z.const('google'), z.const('off')]).default('google').volatile(),

  publicBaseUrl: z.string().default('').volatile(), // for webhook platforms (LINE/WhatsApp) behind a tunnel/proxy
  cwd: z.string().default('').volatile(),
  preset: z.string().default('').volatile(),
  titlePrefix: z.string().default('[MSG] ').volatile(),

  maxCharsPerMessage: z.number().default(1800).volatile(),
  maxChunksPerReply: z.number().default(3).volatile(),
  replyLengthPrompt: z.string().default(
    'ตอบให้กระชับ (ไม่เกิน ~1500 ตัวอักษรต่อข้อความ) ถ้าเนื้อหายาวให้ย่อใจความสำคัญ อย่าสร้างตาราง markdown',
  ).volatile(),
  counterEnabled: z.boolean().default(true).volatile(),
  counterFile: z.string().default('').volatile(),
  stateFile: z.string().default('').volatile(),
  loadingIndicator: z.boolean().default(true).volatile(),
  showStatsFooter: z.boolean().default(true).volatile(),

  line: lineSchema.default({}),
  telegram: telegramSchema.default({}),
  wa: waSchema.default({}),
  broadcast: broadcastSchema.default({}),
})

// JS fallbacks so partially-configured sub-objects still resolve every field.
const LINE_DEFAULTS = {
  channelAccessToken: '', channelAccessTokenEnv: 'LINE_CHANNEL_ACCESS_TOKEN',
  channelSecret: '', channelSecretEnv: 'LINE_CHANNEL_SECRET',
  allowedUserIds: [], allowedGroupIds: [], allowedRoomIds: [],
  requireMentionInGroup: true, preferReplyToken: true,
  webhookPath: '/plugins/messaging/line/webhook',
}
const TG_DEFAULTS = {
  botToken: '', botTokenEnv: 'TELEGRAM_BOT_TOKEN', receiveMode: 'longpoll',
  allowedUserIds: [], allowedChatIds: [], requireMentionInGroup: false,
  editLiveStatus: true, useRichStreaming: true,
  webhookPath: '/plugins/messaging/telegram/webhook',
}
const WA_DEFAULTS = {
  accessToken: '', accessTokenEnv: 'WHATSAPP_ACCESS_TOKEN', phoneNumberId: '',
  appSecret: '', appSecretEnv: 'WHATSAPP_APP_SECRET', verifyToken: '',
  allowedUserIds: [], allowedGroupIds: [], outOfWindowTemplate: '',
  webhookPath: '/plugins/messaging/whatsapp/webhook',
}
const BROADCAST_DEFAULTS = { enabled: false, shareSession: false, platforms: [] }

/** Recursively unwrap live `Volatile<T>` references the Loader hands us for
 *  `.volatile()` leaves (containers stay plain objects; leaves become values). */
function unwrap(v) {
  if (Array.isArray(v)) return v.map(unwrap)
  if (v && typeof v === 'object') {
    if (typeof v.get === 'function') return unwrap(v.get())
    const out = {}
    for (const k of Object.keys(v)) out[k] = unwrap(v[k])
    return out
  }
  return v
}

/** Parse + deep-fill defaults into a plain object. Safe to call with {} or with
 *  the live config (whose volatile leaves are `Volatile` references). */
export function resolveConfig(raw) {
  // Unwrap first (cordis passes refs), re-validate to fill defaults, unwrap again
  // (Config re-wraps volatile leaves), then deep-fill sub-objects.
  let c
  try { c = unwrap(Config(unwrap(raw ?? {}))) } catch { c = { ...(raw ?? {}) } }
  return {
    ...c,
    line: { ...LINE_DEFAULTS, ...(c.line || {}) },
    telegram: { ...TG_DEFAULTS, ...(c.telegram || {}) },
    wa: { ...WA_DEFAULTS, ...(c.wa || {}) },
    broadcast: { ...BROADCAST_DEFAULTS, ...(c.broadcast || {}) },
  }
}
