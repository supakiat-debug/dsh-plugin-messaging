// counter.js — per-month message counter (JSON, atomic). Resets on YYYY-MM change.
// Doubles as a cost-management tool: on LINE, replies that miss the 60s reply
// token go via metered Push, so counting outbound messages tracks spend.
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'

function monthKey(d = new Date()) { return d.toISOString().slice(0, 7) } // YYYY-MM

function blank(month) {
  return {
    month,
    inbound: 0,        // messages received from users
    outboundMsg: 0,    // replies produced (logical replies)
    outboundChunks: 0, // actual messages sent (>= outboundMsg when split)
    pushMsgs: 0,       // sent via metered push (LINE/WhatsApp)
    replyMsgs: 0,      // sent via free reply token / webhook response
    translated: 0,     // replies that went through translation
  }
}

export class MonthlyCounter {
  constructor(file, log = () => {}) {
    this.file = file
    this.log = log
    this.data = blank(monthKey())
    this._load()
  }
  _load() {
    try {
      const d = JSON.parse(readFileSync(this.file, 'utf8'))
      if (d && d.month === monthKey()) this.data = { ...blank(d.month), ...d }
      else this._roll()
    } catch { /* first run */ }
  }
  _roll() {
    const m = monthKey()
    if (this.data.month !== m) { this.data = blank(m); this._save() }
  }
  _save() {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const tmp = this.file + '.tmp'
      writeFileSync(tmp, JSON.stringify(this.data, null, 2))
      renameSync(tmp, this.file)
    } catch (e) { this.log('counter save failed: ' + e.message) }
  }
  incInbound() { this._roll(); this.data.inbound++; this._save() }
  incOutbound({ chunks = 1, kind = 'push', translated = false } = {}) {
    this._roll()
    this.data.outboundMsg++
    this.data.outboundChunks += Math.max(1, chunks | 0)
    if (kind === 'push') this.data.pushMsgs++
    else this.data.replyMsgs++
    if (translated) this.data.translated++
    this._save()
  }
  snapshot() { this._roll(); return { ...this.data } }
}
