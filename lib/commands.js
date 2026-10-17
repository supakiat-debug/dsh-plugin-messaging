// commands.js — parse an inbound slash command. Pure, no deps.
// Returns { type, arg? } or null when the text is not a command.

export function parseCommand(text) {
  const t = (text ?? '').trim()
  if (!t.startsWith('/')) return null
  const [raw, ...rest] = t.slice(1).split(/\s+/)
  const name = (raw || '').toLowerCase()
  const arg = rest.join(' ').trim()
  switch (name) {
    case 'new': return { type: 'new', arg }
    case 'sessions': case 'list': return { type: 'sessions' }
    case 'use': case 'switch': case 'resume': return { type: 'use', arg }
    case 'current': case 'session': return { type: 'current' }
    case 'stop': case 'cancel': return { type: 'stop' }
    case 'status': return { type: 'status' }
    case 'count': return { type: 'count' }
    case 'quota': return { type: 'quota' }
    case 'lang': return { type: 'lang', arg }
    case 'model': return { type: 'model', arg }
    case 'help': case 'start': return { type: 'help' }
    default: return { type: 'unknown', name }
  }
}

// Help text lives in messages.js (HELP_LINES) so it can be translated like the
// rest of the bridge's own messages.
