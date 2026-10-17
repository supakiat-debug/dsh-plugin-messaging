// reply.js — fold an agent's session events into the final reply text.
// Mirrors the Discord bridge's event model exactly:
//   { seq, type, data }
//   user/message      -> data.source.<platform>MessageId
//   assistant/message -> data.message.content = [{ type:'text', text }]
//   turn/end          -> data.reason.kind, data.reason.error.message

/**
 * Find the seq of the user/message event whose source matches `predicate`.
 * Scans backwards so we anchor on the most recent prompt.
 * @returns {number|undefined}
 */
export function findPromptSeq(events, predicate) {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (!e || e.type !== 'user/message') continue
    if (predicate(e.data?.source)) return e.seq
  }
  return undefined
}

/**
 * Fold assistant text from `promptSeq` until the turn ends. The last
 * non-empty assistant message wins (matches the host's accumulation model).
 * @returns {{text: string, reasonKind: string|undefined, errorMessage: string|undefined}}
 */
export function extractReply(events, promptSeq) {
  let text = ''
  let reasonKind
  let errorMessage
  if (!Array.isArray(events) || promptSeq === undefined) return { text, reasonKind, errorMessage }
  for (const e of events) {
    if (e.seq < promptSeq) continue
    if (e.type === 'assistant/message') {
      const joined = (e.data?.message?.content ?? [])
        .filter((b) => b?.type === 'text')
        .map((b) => b.text ?? '')
        .join('')
      if (joined !== '') text = joined
      continue
    }
    if (e.type === 'turn/end') {
      const r = e.data?.reason
      reasonKind = r?.kind
      errorMessage = r?.error?.message
      break
    }
  }
  return { text, reasonKind, errorMessage }
}
