// mcpctl.js — /tools: enable/disable MCP servers through dsh-mcp-manager-plus.
//
// The manager plugin owns the durable MCP rows in cordis.patch.yml and serves a
// loopback-only HTTP API on the harness web server (prefix /mcp-manager-plus) —
// the same calls the browser "MCP 管理" page makes. We stay a thin HTTP client
// instead of touching the patch file: one writer keeps the file's comments and
// layout intact, and the live reload the profile runs (patchReload: live)
// converges the running fibers a moment after the write.
//
// Routes used:
//   GET  /servers  -> { servers: [{ id, serverName, source, enabled, live… }] }
//   POST /toggle   -> body { id, enabled } -> { ok, action, id }
//
// @module dsh-plugin-messaging/mcpctl

const API_PREFIX = '/mcp-manager-plus'

/** Loopback base URL of the manager API, from the live webServer service. */
function baseUrl(ctx) {
  const port = ctx.get('webServer')?.port
  if (!port) throw new Error('web server is not listening yet')
  return `http://127.0.0.1:${port}${API_PREFIX}`
}

/** One same-host API call with a timeout; non-2xx becomes a thrown Error. */
async function call(ctx, route, body, timeoutMs = 15000) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(`${baseUrl(ctx)}${route}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    })
    const text = await res.text()
    let data
    try { data = text ? JSON.parse(text) : {} } catch { data = { error: text.slice(0, 200) } }
    if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`)
    return data
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Every MCP server the manager reports (user rows, bundle rows, built-ins).
 * @param {object} ctx - host context.
 * @returns {Promise<Array<object>>} server entries.
 */
export async function mcpList(ctx) {
  const data = await call(ctx, '/servers?lang=en')
  return Array.isArray(data?.servers) ? data.servers : []
}

/**
 * Resolve a chat-typed name to one server: exact (case-insensitive) first, then
 * a unique substring.
 * @param {Array<object>} servers - entries from mcpList.
 * @param {string} name - user input.
 * @returns {{server?: object, ambiguous?: Array, missing?: boolean}} match result.
 */
export function matchServer(servers, name) {
  const n = String(name ?? '').trim().toLowerCase()
  if (!n) return { missing: true }
  const exact = servers.filter((s) => String(s.serverName).toLowerCase() === n)
  if (exact.length) return { server: exact[0] }
  const sub = servers.filter((s) => String(s.serverName).toLowerCase().includes(n))
  if (sub.length === 1) return { server: sub[0] }
  if (sub.length > 1) return { ambiguous: sub }
  return { missing: true }
}

/**
 * Turn one server on or off.
 * @param {object} ctx - host context.
 * @param {string} name - server name (exact or unique substring).
 * @param {boolean} enabled - desired state.
 * @returns {Promise<object>} one of:
 *   { name, action }        toggled (patch written; live reload follows shortly)
 *   { name, unchanged: true } already in the desired state
 *   { name, builtin: true }  harness built-in, not togglable through the patch
 *   { names }                the typed name matched several servers
 *   { missing: true, known }  no match (known names attached for the reply)
 */
export async function mcpSet(ctx, name, enabled) {
  const servers = await mcpList(ctx)
  const m = matchServer(servers, name)
  if (!m.server) return m.ambiguous
    ? { ambiguous: m.ambiguous.map((s) => s.serverName) }
    : { missing: true, known: servers.map((s) => s.serverName) }
  const server = m.server
  if (server.source === 'builtin' || !server.id) return { builtin: true, name: server.serverName }
  if (server.enabled === enabled) return { name: server.serverName, unchanged: true }
  // The manager reads `enabled === true` strictly; pass a real boolean.
  const r = await call(ctx, '/toggle', { id: server.id, enabled: enabled === true })
  return { name: server.serverName, action: r?.action || (enabled ? 'enabled' : 'disabled') }
}
