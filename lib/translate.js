// translate.js — translate the *stored* reply text into a target language, with a
// persistent cache ("ใช้การแปลข้อความเก็บไว้").
//
// Design: the AI answers in whatever language it likes; we take the final reply
// text and translate it to the configured reply language before chunking/sending.
// Translations are cached by sha1(target + source) so repeated strings (menus,
// footers, common answers) never hit the network twice.
//
// Backend: the free Google web endpoint (no API key). Pluggable via opts.fetch
// for tests, and opts.backend='off' to disable entirely. On any failure we pass
// the original text through (never lose a reply because translation failed).

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'

// Our language codes -> Google translate target codes.
const GOOGLE_TARGET = { en: 'en', zh: 'zh-CN', th: 'th' }

export const LANGUAGES = [
  { code: 'en', label: 'English', flag: '🇬🇧' },
  { code: 'zh', label: '中文', flag: '🇨🇳' },
  { code: 'th', label: 'ไทย', flag: '🇹🇭' },
]

function normalizeLang(l) {
  if (!l) return ''
  const s = String(l).toLowerCase()
  if (s.startsWith('zh')) return 'zh'
  if (s.startsWith('th')) return 'th'
  if (s.startsWith('en')) return 'en'
  return s.split(/[-_]/)[0]
}

/**
 * @param {{backend?: 'google'|'off', cacheFile?: string, log?: Function, fetch?: Function}} opts
 */
export function createTranslator(opts = {}) {
  const backend = opts.backend ?? 'google'
  const cacheFile = opts.cacheFile
  const log = opts.log ?? (() => {})
  const fetchImpl = opts.fetch ?? globalThis.fetch
  const cache = new Map()
  let dirty = false

  if (cacheFile) {
    try { Object.assign(cache, JSON.parse(readFileSync(cacheFile, 'utf8'))) } catch { /* first run */ }
  }
  function persist() {
    if (!cacheFile || !dirty) return
    try {
      mkdirSync(dirname(cacheFile), { recursive: true })
      const tmp = cacheFile + '.tmp'
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(cache)))
      renameSync(tmp, cacheFile)
      dirty = false
    } catch (e) { log('translate cache persist failed: ' + e.message) }
  }
  const key = (text, target) => createHash('sha1').update(target + '\u0000' + text).digest('hex')

  /**
   * Translate `text` to `target` ('en'|'zh'|'th'). Returns original text when
   * translation is off, target is unset, or on any error.
   */
  async function translate(text, target) {
    if (!text || backend === 'off' || !target) return text
    const k = key(text, target)
    if (cache.has(k)) return cache.get(k)
    try {
      const url =
        'https://translate.googleapis.com/translate_a/single?client=gtx&dt=t&sl=auto' +
        `&tl=${encodeURIComponent(GOOGLE_TARGET[target] ?? target)}` +
        `&q=${encodeURIComponent(text)}`
      const res = await fetchImpl(url)
      if (!res.ok) throw new Error('HTTP ' + res.status)
      const data = await res.json()
      const translated = (data?.[0] ?? []).map(seg => seg?.[0] ?? '').join('')
      const detected = normalizeLang(data?.[2])
      // If the source is already the target language, keep the original (avoid churn).
      const final = (detected && detected === normalizeLang(target)) ? text : (translated || text)
      cache.set(k, final)
      dirty = true
      persist()
      return final
    } catch (e) {
      log('translate failed, passthrough: ' + e.message)
      return text
    }
  }

  return { translate, get size() { return cache.size } }
}
