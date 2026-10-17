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

import { Config, resolveConfig } from './config.js'
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
    const started = []     // adapters we actually started (for teardown)
    const byPlatform = {}  // platform -> live adapter (the bridge broadcasts through these)

    const dir = dataDir(ctx.baseUrl)
    const store = new BindingStore(resolveFile(cfg.stateFile, ctx.baseUrl, 'messaging-bridge-state.json'), (m) => logger.warn(m))
    const counter = new MonthlyCounter(resolveFile(cfg.counterFile, ctx.baseUrl, 'messaging-bridge-counter.json'), (m) => logger.warn(m))
    const translator = createTranslator({ backend: cfg.translateBackend, cacheFile: join(dir, 'messaging-translate-cache.json'), log: (m) => logger.warn(m) })
    const bridge = createBridge({ cfg, ctx, store, counter, translator, adapters: byPlatform, log: (m) => logger.warn(m) })

    ;(async () => {
      await ctx.get('loader')?.await?.()
      store.load()

      const deps = { bridge, ctx, log: (m) => logger.info(m) }
      const make = {
        telegram: () => createTelegramAdapter(cfg, deps),
        line: () => createLineAdapter(cfg, deps),
        whatsapp: () => createWhatsAppAdapter(cfg, deps),
      }
      // Broadcast mode runs every credential-configured adapter at once (each idles
      // itself when its token is unset), so switching channels needs no restart.
      // Otherwise only the selected primary platform runs, exactly as before.
      const want = cfg.broadcast?.enabled ? ['line', 'telegram', 'whatsapp'] : [cfg.platform]

      for (const p of want) {
        const a = make[p]?.()
        if (!a) { logger.warn(`platform '${p}' has no adapter in this build (discord is served by dsh-plugin-discord)`); continue }
        byPlatform[p] = a
        try { await a.start(); started.push(a) } catch (e) { logger.warn(`${p} start failed: ` + (e?.stack || e)) }
      }
      logger.info(`messaging-bridge started (platform=${cfg.platform}, broadcast=${!!cfg.broadcast?.enabled} -> [${want.join(', ')}], replyLanguage=${cfg.replyLanguage}, translate=${cfg.translateBackend}, counter=${cfg.counterEnabled})`)
    })().catch((e) => logger.warn('boot failed: ' + (e?.stack || e)))

    return () => {
      disposed = true
      for (const a of started) { try { a.stop?.() } catch { /* ignore */ } }
      store.flush()
    }
  }, 'messaging bridge lifecycle')
}
