// deliver.js — the last centimetre of the outbound path, kept free of cordis so it
// can be unit-tested on its own.
//
// Two rules live here, both earned from bugs:
//
//  1. A live status is a nice-to-have, the answer is not. Adapters with editable
//     messages (Telegram, Discord) edit the "🤖 Thinking…" bubble into the reply,
//     and `status.replace()` throws when that edit is refused — the bubble was
//     deleted, the channel revoked permission, the edit route rate limited. Throwing
//     from here used to abort the turn and swallow the answer the user was waiting
//     for. So: try the edit, and if it fails send everything as a plain message.
//
//  2. Only count what the platform accepted. `send()` reports how many chunks it
//     actually delivered (`sent`); when it throws, the error carries the same
//     number. A 503 from Graph API is not a delivered message, and counting it as
//     one hides a dead channel behind a healthy-looking outbound counter.
//
// `kind` keeps the meaning the counter expects: 'reply' only when the live status
// carried the entire answer (a free round trip). If any of it had to be pushed, the
// adapter's own kind for that tail is used — the metered half of a mixed delivery is
// what the quota should remember.

/**
 * Deliver one reply, working around a broken live status.
 *
 * @param {object} opts
 * @param {{ replace: (text: string) => Promise<any> } | undefined} opts.status
 *   live status handle from `ev.startStatus`, if the platform has one
 * @param {string[]} opts.chunks - the reply, already chunked for this platform
 * @param {(chunks: string[]) => Promise<{kind?: string, sent?: number}>} opts.send
 *   the adapter's plain-send path (`ev.send`)
 * @param {(text: string) => void} [opts.log]
 * @returns {Promise<{kind: string, sent: number, replaced: boolean}>} `sent` counts
 *   chunks the platform accepted; on a thrown error the same number rides on `err.sent`
 */
export async function deliverChunks({ status, chunks, send, log = () => {} }) {
  if (!chunks || !chunks.length) return { kind: 'push', sent: 0, replaced: false }

  // Editing the status in place delivers chunk #1 for free (no extra message).
  let head = 0
  if (status && typeof status.replace === 'function') {
    try {
      await status.replace(chunks[0])
      head = 1
    } catch (e) {
      log(`live status could not become the answer (${e?.message || e}) — sending the reply as a new message instead`)
    }
  }

  const rest = chunks.slice(head)
  if (!rest.length) return { kind: 'reply', sent: head, replaced: true }

  try {
    const r = await send(rest)
    // An adapter that does not report `sent` is counted optimistically; adapters that
    // do (Messenger/LINE/WhatsApp) keep the counter honest.
    const sent = head + (Number.isFinite(r?.sent) ? r.sent : rest.length)
    return { kind: r?.kind ?? 'push', sent, replaced: Boolean(head) }
  } catch (e) {
    // Partial delivery: say how much reached the user, so the counter matches reality
    // and a retry does not resend what already arrived.
    if (e && typeof e === 'object') e.sent = head + (Number.isFinite(e.sent) ? e.sent : 0)
    throw e
  }
}
