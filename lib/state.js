// state.js — chat -> session binding store (JSON, atomic write). Pure node:fs.
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'

export class BindingStore {
  constructor(file, log = () => {}) {
    this.file = file
    this.log = log
    this.data = { channels: {} }
    this._dirty = false
  }
  load() {
    try {
      const d = JSON.parse(readFileSync(this.file, 'utf8'))
      if (d && typeof d === 'object') this.data = { channels: d.channels || {} }
    } catch { /* first run */ }
    return this
  }
  get(key) { return this.data.channels[key] }
  set(key, value) { this.data.channels[key] = value; this._dirty = true; this.flush() }
  delete(key) { delete this.data.channels[key]; this._dirty = true; this.flush() }
  entries() { return Object.entries(this.data.channels) }
  flush() {
    if (!this._dirty) return
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const tmp = this.file + '.tmp'
      writeFileSync(tmp, JSON.stringify(this.data, null, 2))
      renameSync(tmp, this.file)
      this._dirty = false
    } catch (e) { this.log('state flush failed: ' + e.message) }
  }
}
