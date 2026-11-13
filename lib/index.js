// index.js — dsh-plugin-messaging: a multi-platform messaging bridge.
//
// One plugin, one `platform` discriminator (line | telegram | whatsapp | discord).
// Binds chats to ordinary dsh sessions (same presets/persistence/title the web
// UI uses), drives turns, translates the stored reply to the configured language
// (en default / zh / th), chunks it to the platform limit, and counts messages
// per month. A Settings > Messaging section (see src/client.tsx) edits this Config.
//
// @module dsh-plugin-messaging

import os from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Config, resolveConfig, wantedPlatforms } from './config.js'
import { BindingStore } from './state.js'
import { MonthlyCounter } from './counter.js'
import { createTranslator } from './translate.js'
import { createBridge } from './bridge.js'
import { createTelegramAdapter } from './adapters/telegram.js'
import { createLineAdapter } from './adapters/line.js'
import { createWhatsAppAdapter } from './adapters/whatsapp.js'

export const name = 'messaging-bridge'

/** Core services required to start. webServer carries the webhook surface. */
export const inject = ['agents', 'sessions', 'agentDefaultModel', 'webServer']

export { Config }

function loggerOf(ctx) {
  const l = ctx.logger
  return {
    info: (...a) => { console.log('[messaging]', ...a); l?.info?.(...a) },
    warn: (...a) => { console.warn('[messaging]', ...a); l?.warn?.(...a) },
  }
}

/** Where state/counter/translation-cache persist: profile dir (file: baseUrl) or ~/.dsh. */
function dataDir(baseUrl) {
  if (typeof baseUrl === 'string' && baseUrl.startsWith('file:')) {
    try { return dirname(fileURLToPath(baseUrl)) } catch { /* fall through */ }
  }
  return join(os.homedir(), '.dsh')
}
const resolveFile = (configured, baseUrl, fallback) => configured || join(dataDir(baseUrl), fallback)

export function apply(ctx, config) {
  const logger = loggerOf(ctx)
  const cfg = resolveConfig(config)

  if (!cfg.enabled) {
    logger.info('messaging-bridge disabled (set config.enabled: true to start)')
    return
  }

  ctx.effect(() => {
    let disposed = false
    const byPlatform = {}  // platform -> live adapter (the bridge broadcasts through these)

    const dir = dataDir(ctx.baseUrl)
    const store = new BindingStore(resolveFile(cfg.stateFile, ctx.baseUrl, 'messaging-bridge-state.json'), (m) => logger.warn(m))
    const counter = new MonthlyCounter(resolveFile(cfg.counterFile, ctx.baseUrl, 'messaging-bridge-counter.json'), (m) => logger.warn(m))
    const translator = createTranslator({ backend: cfg.translateBackend, cacheFile: join(dir, 'messaging-translate-cache.json'), log: (m) => logger.warn(m) })
    const bridge = createBridge({ cfg, ctx, store, counter, translator, adapters: byPlatform, log: (m) => logger.warn(m) })

    const deps = { bridge, ctx, log: (m) => logger.info(m) }
    const make = {
      telegram: () => createTelegramAdapter(cfg, deps),
      line: () => createLineAdapter(cfg, deps),
      whatsapp: () => createWhatsAppAdapter(cfg, deps),
    }

    /**
     * Open exactly the channels the config wants: the primary platform plus every
     * channel ticked "Keep the connection open" (all three in broadcast mode, which
     * is what lets you switch channels with no restart). Runs at boot and again on
     * every volatile settings save that touches the channel selection, so ticking a
     * "Keep the connection open" box starts listening — and un-ticking it closes the
     * webhook route / ends the long-poll — without restarting the plugin.
     * Serialized so two saves in a row cannot interleave starts/stops.
     */
    let queue = Promise.resolve()
    const reconcile = (why) => {
      queue = queue.then(() => reconcileNow(why)).catch((e) => logger.warn('reconcile failed: ' + (e?.stack || e)))
      return queue
    }
    async function reconcileNow(why) {
      if (disposed) return
      // `enabled` is volatile too, so switching the bridge off in the Settings page
      // closes every connection live instead of waiting for a restart.
      const want = cfg.enabled === false ? [] : wantedPlatforms(cfg)
      for (const p of want) {
        if (byPlatform[p]) continue
        const a = make[p]?.()
        if (!a) { logger.warn(`platform '${p}' has no adapter in this build (discord is served by dsh-plugin-discord)`); continue }
        byPlatform[p] = a
        try { await a.start() } catch (e) {
          delete byPlatform[p]
          logger.warn(`${p} start failed: ` + (e?.stack || e))
        }
      }
      for (const p of Object.keys(byPlatform)) {
        if (want.includes(p)) continue
        const a = byPlatform[p]
        delete byPlatform[p]
        try { a.stop?.() } catch { /* ignore */ }
        logger.info(`${p}: connection closed (${why})`)
      }
      const kept = ['line', 'telegram', 'wa'].filter((k) => cfg[k]?.keepOpen).join(',') || '-'
      logger.info(`messaging-bridge listening [${Object.keys(byPlatform).join(', ') || 'none'}] (${why}: platform=${cfg.platform}, keepOpen=${kept}, broadcast=${!!cfg.broadcast?.enabled})`)
    }

    // Only these config paths change WHICH channels run; a token or a chunk budget
    // edit must not tear a working connection down.
    const touchesChannels = (paths) => (paths || []).some((p) => {
      const [head, second] = p || []
      if (head === 'platform' || head === 'broadcast' || head === 'enabled') return true
      return (head === 'line' || head === 'telegram' || head === 'wa') && second === 'keepOpen'
    })
    ctx.on('loader/volatile-update', (paths) => {
      if (!disposed && touchesChannels(paths)) void reconcile('settings saved')
    })

    ;(async () => {
      await ctx.get('loader')?.await?.()
      store.load()
      await reconcile('boot')
      logger.info(`messaging-bridge started (platform=${cfg.platform}, replyLanguage=${cfg.replyLanguage}, translate=${cfg.translateBackend}, counter=${cfg.counterEnabled})`)
    })().catch((e) => logger.warn('boot failed: ' + (e?.stack || e)))

    return () => {
      disposed = true
      for (const a of Object.values(byPlatform)) { try { a.stop?.() } catch { /* ignore */ } }
      store.flush()
    }
  }, 'messaging bridge lifecycle')
}
