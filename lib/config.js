// config.js — schemastery Config schema for the messaging bridge.
// One plugin, one `platform` discriminator (line | telegram | whatsapp | discord |
// messenger); each platform has its own sub-object.
// `replyLanguage` (en default / zh / th) drives the post-reply translation step.
//
// Every editable leaf is marked `.volatile()` so the host settings seam exposes it
// (dsh-settings only surfaces volatile fields — see dsh-free-search for the same
// pattern). Secrets carry `.role('secret')` so the remote describe() redacts them.
// Volatile leaves parse into live `Volatile<T>` references; `resolveConfig` below
// unwraps them (recursively, since our sub-objects are non-volatile containers).
//
// Because EVERY editable leaf is volatile, a settings save is a volatile-only
// change: cordis-plugin-loader commits the new values into the refs the fiber
// already holds and emits `loader/volatile-update` WITHOUT re-running apply().
// That is why resolveConfig returns a live view over those refs — reading
// `cfg.replyLanguage` after a save gives the new language, not the boot snapshot.

import z from '@deepseek-ai/schemastery'

const lang = z.union([z.const('en'), z.const('zh'), z.const('th')])
const platform = z.union([z.const('line'), z.const('telegram'), z.const('whatsapp'), z.const('discord'), z.const('messenger')])

// "Keep the connection open": listen on this channel even when it is not the
// selected primary platform, so messages can arrive on it any time. It is a
// per-platform field because each channel has its own credentials / webhook path.
const keepOpen = (hint) => z.boolean().default(false).description(`Keep this channel listening: ${hint}`).volatile()

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
  keepOpen: keepOpen('keeps the LINE webhook route registered and waiting'),
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
  keepOpen: keepOpen('keeps the Telegram long-poll running'),
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
  keepOpen: keepOpen('keeps the WhatsApp webhook route registered and waiting'),
})

// Discord is the one platform with NO webhook: the bot opens an outbound WebSocket to
// the gateway, so it works behind NAT with no public URL, no tunnel and no TLS. See
// adapters/discord.js for the gateway protocol and the privileged-intent caveat.
const discordSchema = z.object({
  botToken: z.string().role('secret').default('').volatile(),
  botTokenEnv: z.string().default('DISCORD_BOT_TOKEN').volatile(),
  // Only set these two to point at a different host (test server / relay).
  gatewayUrl: z.string().default('').volatile(),
  apiBaseUrl: z.string().default('').volatile(),
  // Privileged intent (Developer Portal → Bot → Privileged Gateway Intents). Leave it
  // on: without it guild message text arrives empty (DMs still work).
  messageContentIntent: z.boolean().default(true).volatile(),
  // In servers, answer only when the bot is @mentioned (DMs always answer).
  requireMentionInGuild: z.boolean().default(true).volatile(),
  ignoreBots: z.boolean().default(true).volatile(),
  // Edit-capable: "thinking…" is edited in place, then replaced by the answer.
  editLiveStatus: z.boolean().default(true).volatile(),
  allowedUserIds: z.array(String).default([]).volatile(),
  allowedChannelIds: z.array(String).default([]).volatile(),
  allowedGuildIds: z.array(String).default([]).volatile(),
  keepOpen: keepOpen('keeps the Discord gateway WebSocket connected and waiting'),
})

// Facebook Messenger (Meta Graph API): Page webhook + Page access token + the 24-hour
// messaging window. Webhook-only, like WhatsApp, so a public HTTPS URL is required.
const messengerSchema = z.object({
  pageAccessToken: z.string().role('secret').default('').volatile(),
  pageAccessTokenEnv: z.string().default('MESSENGER_PAGE_ACCESS_TOKEN').volatile(),
  appSecret: z.string().role('secret').default('').volatile(),
  appSecretEnv: z.string().default('MESSENGER_APP_SECRET').volatile(),
  verifyToken: z.string().default('').volatile(),
  // Optional Page ID. Empty posts to /me/messages, which resolves to the Page the token
  // belongs to — fine for one Page per adapter.
  pageId: z.string().default('').volatile(),
  // Meta rolls Graph versions on a fixed schedule; newer than this only needs a save.
  graphVersion: z.string().default('v24.0').volatile(),
  allowedUserIds: z.array(String).default([]).volatile(),
  // Fallback when the 24h window has closed: HUMAN_AGENT / ACCOUNT_UPDATE /
  // CONFIRMED_EVENT_UPDATE / POST_PURCHASE_UPDATE. Empty = do not retry.
  outOfWindowTag: z.string().default('').volatile(),
  typingIndicator: z.boolean().default(true).volatile(),
  webhookPath: z.string().default('/plugins/messaging/messenger/webhook').volatile(),
  keepOpen: keepOpen('keeps the Messenger webhook route registered and waiting'),
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

  // Privileged chat commands. Both are gated by the platform allowlists above —
  // a chat that can talk to the bridge can already tell it to run tools, so
  // these only control whether the two extra commands exist at all.
  // /access read|write|full — switch this chat's session permission preset.
  accessCommands: z.boolean().default(true).volatile(),
  // /tools [<name> on|off] — list / toggle MCP servers via dsh-mcp-manager-plus.
  mcpCommands: z.boolean().default(true).volatile(),
  // Register the scoped request_access tool, so the AI can ask the chat for a
  // level instead of hitting the wall silently (the user still grants by hand).
  aiAccessRequest: z.boolean().default(true).volatile(),

  line: lineSchema.default({}),
  telegram: telegramSchema.default({}),
  wa: waSchema.default({}),
  discord: discordSchema.default({}),
  messenger: messengerSchema.default({}),
  broadcast: broadcastSchema.default({}),
})

// JS fallbacks so partially-configured sub-objects still resolve every field.
const LINE_DEFAULTS = {
  channelAccessToken: '', channelAccessTokenEnv: 'LINE_CHANNEL_ACCESS_TOKEN',
  channelSecret: '', channelSecretEnv: 'LINE_CHANNEL_SECRET',
  allowedUserIds: [], allowedGroupIds: [], allowedRoomIds: [],
  requireMentionInGroup: true, preferReplyToken: true,
  webhookPath: '/plugins/messaging/line/webhook', keepOpen: false,
}
const TG_DEFAULTS = {
  botToken: '', botTokenEnv: 'TELEGRAM_BOT_TOKEN', receiveMode: 'longpoll',
  allowedUserIds: [], allowedChatIds: [], requireMentionInGroup: false,
  editLiveStatus: true, useRichStreaming: true,
  webhookPath: '/plugins/messaging/telegram/webhook', keepOpen: false,
}
const WA_DEFAULTS = {
  accessToken: '', accessTokenEnv: 'WHATSAPP_ACCESS_TOKEN', phoneNumberId: '',
  appSecret: '', appSecretEnv: 'WHATSAPP_APP_SECRET', verifyToken: '',
  allowedUserIds: [], allowedGroupIds: [], outOfWindowTemplate: '',
  webhookPath: '/plugins/messaging/whatsapp/webhook', keepOpen: false,
}
const BROADCAST_DEFAULTS = { enabled: false, shareSession: false, platforms: [] }
const DISCORD_DEFAULTS = {
  botToken: '', botTokenEnv: 'DISCORD_BOT_TOKEN', gatewayUrl: '', apiBaseUrl: '',
  messageContentIntent: true, requireMentionInGuild: true, ignoreBots: true,
  editLiveStatus: true, allowedUserIds: [], allowedChannelIds: [], allowedGuildIds: [],
  keepOpen: false,
}
const MESSENGER_DEFAULTS = {
  pageAccessToken: '', pageAccessTokenEnv: 'MESSENGER_PAGE_ACCESS_TOKEN',
  appSecret: '', appSecretEnv: 'MESSENGER_APP_SECRET', verifyToken: '', pageId: '',
  graphVersion: 'v24.0', allowedUserIds: [], outOfWindowTag: '', typingIndicator: true,
  webhookPath: '/plugins/messaging/messenger/webhook', keepOpen: false,
}

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

const isRef = (v) => !!v && typeof v === 'object' && typeof v.get === 'function'
const SUBS = new Set(['line', 'telegram', 'wa', 'discord', 'messenger', 'broadcast'])

/** Does this raw config carry live refs (i.e. did cordis hand it to us), as opposed
 *  to a plain object from a test / a hand-written file? */
const isLive = (raw) => !!raw && typeof raw === 'object' && Object.keys(raw).some((k) => isRef(raw[k]))

const define = (obj, key, get) => Object.defineProperty(obj, key, { get, enumerable: true, configurable: true })

/** Live view over the refs cordis owns: EVERY read unwraps the current value, so a
 *  settings save lands without a restart (the loader commits volatile-only changes
 *  into these very refs). Anything the host did not send falls back to `base`. */
function liveView(raw, base) {
  const read = (holder, key, fallback) => {
    const v = holder ? holder[key] : undefined
    return v === undefined ? fallback : unwrap(v)
  }
  const sub = (key) => {
    const out = {}
    for (const k of Object.keys(base[key])) define(out, k, () => read(raw?.[key], k, base[key][k]))
    return out
  }
  const view = {}
  for (const key of Object.keys(base)) {
    if (SUBS.has(key)) { view[key] = sub(key); continue }
    define(view, key, () => read(raw, key, base[key]))
  }
  return view
}

/** Parse + deep-fill defaults. Safe with `{}`, a plain object, or the live config
 *  (whose volatile leaves are `Volatile` refs — then the result keeps reading
 *  through them, see `liveView`). */
export function resolveConfig(raw) {
  // Unwrap first (cordis passes refs), re-validate to fill defaults, unwrap again
  // (Config re-wraps volatile leaves), then deep-fill sub-objects.
  const source = raw ?? {}
  let c
  try { c = unwrap(Config(unwrap(source))) } catch { c = { ...source } }
  const base = {
    ...c,
    line: { ...LINE_DEFAULTS, ...(c.line || {}) },
    telegram: { ...TG_DEFAULTS, ...(c.telegram || {}) },
    wa: { ...WA_DEFAULTS, ...(c.wa || {}) },
    discord: { ...DISCORD_DEFAULTS, ...(c.discord || {}) },
    messenger: { ...MESSENGER_DEFAULTS, ...(c.messenger || {}) },
    broadcast: { ...BROADCAST_DEFAULTS, ...(c.broadcast || {}) },
  }
  return isLive(source) ? liveView(source, base) : base
}

// Adapter key -> config sub-object. `whatsapp` is the adapter, `wa` the config key.
// Discord and Messenger use their own name for both.
const CHANNELS = [['line', 'line'], ['telegram', 'telegram'], ['wa', 'whatsapp'], ['discord', 'discord'], ['messenger', 'messenger']]

/** Every platform this build can run, in menu order. */
export const ALL_PLATFORMS = ['line', 'telegram', 'whatsapp', 'discord', 'messenger']

/** Which channels should be listening right now: the selected primary platform, plus
 *  every channel ticked "Keep the connection open" (in broadcast mode, all of them —
 *  that mode already runs every credential-configured adapter at once). */
export function wantedPlatforms(cfg) {
  if (cfg?.broadcast?.enabled) return [...ALL_PLATFORMS]
  const list = cfg?.platform ? [cfg.platform] : []
  for (const [key, platform] of CHANNELS) {
    if (cfg?.[key]?.keepOpen && !list.includes(platform)) list.push(platform)
  }
  return list
}
