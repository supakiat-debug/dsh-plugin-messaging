// permissions.js — /access: the messaging side of the host's permission presets.
//
// The harness models permissions as two per-session knobs (a shell sandbox mode
// and an approval policy) bundled into presets by dsh-permission-presets, the
// service behind the composer's permission picker. dsh-base ships exactly:
//
//   read-only          sandbox=read-only          approval=ask
//   workspace-write    sandbox=workspace-write    approval=ask
//   danger-full-access sandbox=danger-full-access approval=never
//
// Chat commands want the short form, so /access accepts read | write | full
// (plus a few aliases) and maps them onto those preset names. A deployment that
// renamed or added presets can still be reached by its full preset name — an
// unknown alias falls back to a literal preset-name match against the live
// catalog. Everything goes through the service (never a hand-appended event),
// so the knobs stay consistent and every surface refreshes.
//
// @module dsh-plugin-messaging/permissions

/** The three levels the bridge advertises, in escalation order. */
export const ACCESS_LEVELS = Object.freeze([
  { key: 'read', preset: 'read-only', emoji: '🔒', aliases: ['read', 'r', 'ro', 'readonly', 'read-only'] },
  { key: 'write', preset: 'workspace-write', emoji: '✏️', aliases: ['write', 'w', 'ws', 'workspace', 'workspace-write'] },
  { key: 'full', preset: 'danger-full-access', emoji: '🔓', aliases: ['full', 'f', 'danger', 'full-access', 'danger-full-access'] },
])

/** 'read / write / full' — used in usage strings. */
export const ACCESS_LIST = ACCESS_LEVELS.map((l) => l.key).join(' / ')

/**
 * Resolve one chat token to a level.
 * @param {string} text - raw argument (e.g. 'FULL', 'workspace-write').
 * @returns {object|null} the level, or null when unrecognised.
 */
export function accessLevel(text) {
  const t = String(text ?? '').trim().toLowerCase()
  if (!t) return null
  return ACCESS_LEVELS.find((l) => l.aliases.includes(t)) ?? null
}

/**
 * Look up the permission-presets service (the service behind the composer's
 * permission picker and the built-in /permission command). Returns null on a
 * host where it is not mounted, so callers can degrade to a plain message.
 * @param {object} ctx - host context.
 * @returns {object|null} the service, or null.
 */
export function permissionService(ctx) {
  const get = (n) => { try { return ctx.get(n) } catch { return undefined } }
  const pp = get('permissionPresets') ?? get('permission-presets') ?? get('permission')
  return pp && typeof pp.apply === 'function' && typeof pp.permissionState === 'function' ? pp : null
}

/** The approval service (writes the approval knob so a live agent notices now). */
export function approvalService(ctx) {
  const get = (n) => { try { return ctx.get(n) } catch { return undefined } }
  const a = get('approval') ?? get('userApproval')
  return a && typeof a.setPolicy === 'function' ? a : null
}

/**
 * Whether a level's preset actually exists on this host. A renamed preset
 * catalog is possible, so never assume dsh-base's names survived.
 * @param {object|null} pp - permission-presets service (or null).
 * @param {object} level - a level from ACCESS_LEVELS.
 * @returns {boolean} true when the service can select it.
 */
export function accessSupported(pp, level) {
  const names = pp?.names
  return Array.isArray(names) ? names.includes(level.preset) : false
}

/**
 * The effective knobs of one session, for display. Null knob values mean the
 * session still rides the composition default, so fall back to what the shell /
 * approval services report.
 * @param {object} pp - permission-presets service.
 * @param {object} ctx - host context (for the default-reporting services).
 * @param {object} session - live session.
 * @returns {{preset: string, sandbox: string, approval: string}} knob summary.
 */
export function accessState(pp, ctx, session) {
  const st = pp.permissionState(session) || {}
  const shell = (() => { try { return ctx.get('shell') } catch { return undefined } })()
  const approval = (() => { try { return ctx.get('approval') } catch { return undefined } })()
  return {
    preset: pp.current(session),
    sandbox: st.sandbox ?? shell?.sandboxMode ?? 'workspace-write',
    approval: st.approval ?? approval?.config?.policy ?? 'ask',
  }
}

/**
 * Apply one level to a live agent. Mirrors the built-in /permission command:
 * the approval knob is written through the approval service so the running
 * agent is told immediately (the durable preset write alone would only reach a
 * future resume); when no approval service is mounted, fall back to the
 * service's durable setter, which writes both knobs itself.
 * @param {object} pp - permission-presets service.
 * @param {object|null} approval - user-approval service (or null).
 * @param {object} ctx - host context (for reading back the effective knobs).
 * @param {object} agent - live agent.
 * @param {object} level - a level from ACCESS_LEVELS.
 * @returns {{preset: string, sandbox: string, approval: string}} the new state.
 */
export function applyAccess(pp, approval, ctx, agent, level) {
  const session = agent.session
  if (approval && agent) pp.apply(session, level.preset, (policy) => approval.setPolicy(agent, policy))
  else pp.set(session, level.preset)
  return accessState(pp, ctx, session)
}
