// dsh-plugin-messaging — browser half (prebuilt client bundle, no build step).
//
// Registers a `settings.section` page ("Messaging") that edits this plugin's own
// Config through the host settings RPC (`settings/describe` + `settings/mutate`):
//   - header row: plugin name on the left, reply-language menu (en / 中文 / ไทย)
//     top-right — picking a language writes it at once (no Save, no restart)
//   - platform picker (LINE / Telegram / WhatsApp / Discord) + translate backend
//   - per-platform credential / group / webhook fields; each card is led by a
//     "Keep the connection open" box that opens/closes that channel live (index.js)
//   - chunking + counter toggles
// The namespace is discovered at runtime by matching a distinctive key
// (`replyLanguage` + `platform`), so no hardcoded namespace string is needed.
// Secrets are only sent when changed (a blank field never wipes a stored token).
//
// This file IS the bundle the client module loader serves (one file per package),
// exactly like dsh-qwen-mm-plugins — no tsdown/JSX toolchain required.
//
// @module dsh-plugin-messaging/client

window.__ModuleLoader__.load({
  id: 'dsh-plugin-messaging',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    var react = require('react')
    const { createElement: h, useState, useEffect, useCallback, useRef } = react

    // ── styles (reuse the host design tokens) ────────────────────────────────
    const css =
      '.mb_wrap{display:flex;flex-direction:column;gap:16px;max-width:760px;font-size:13px;line-height:1.55;color:var(--dsw-alias-label-primary);flex:none}' +
      '.mb_card{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:16px 18px;display:flex;flex-direction:column;gap:12px;background:var(--dsw-alias-bg-module-platform,transparent);flex:none}' +
      '.mb_pageTitle{font-size:16px;font-weight:500;line-height:24px}' +
      '.mb_cardTitle{font-size:14px;font-weight:500;line-height:22px}' +
      '.mb_cardDesc{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);margin-top:2px}' +
      '.mb_hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}' +
      '.mb_err{font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary)}' +
      '.mb_saved{font-size:12px;color:var(--dsw-alias-state-success-primary);font-weight:500}' +
      '.mb_row{display:flex;gap:12px;align-items:center;flex-wrap:wrap}' +
      '.mb_field{display:flex;flex-direction:column;gap:4px;flex:1;min-width:220px}' +
      '.mb_label{font-size:12px;font-weight:500;color:var(--dsw-alias-label-secondary)}' +
      '.mb_input,.mb_select{box-sizing:border-box;width:100%;min-height:34px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px}' +
      '.mb_input:focus,.mb_select:focus{border-color:var(--dsw-alias-brand-primary);outline:none}' +
      '.mb_input::placeholder{color:var(--dsw-alias-label-dimmed)}' +
      '.mb_toggle{display:inline-flex;align-items:center;gap:8px;cursor:pointer;user-select:none}' +
      '.mb_btn{box-sizing:border-box;height:34px;padding:0 18px;border:none;border-radius:8px;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);font:inherit;font-weight:500;cursor:pointer;flex:none}' +
      '.mb_btn:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}' +
      '.mb_btn:disabled{opacity:.4;cursor:default}' +
      '.mb_btnGhost{background:transparent;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}' +
      '.mb_footer{display:flex;align-items:center;gap:12px}' +
      '.mb_seg{display:inline-flex;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;overflow:hidden}' +
      '.mb_segBtn{padding:6px 14px;font:inherit;font-size:12px;font-weight:500;background:transparent;color:var(--dsw-alias-label-secondary);border:none;cursor:pointer}' +
      '.mb_segBtnOn{background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-foreground)}' +
      '.mb_head{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap}' +
      '.mb_lang{display:flex;flex-direction:column;gap:4px;flex:none;width:230px}' +
      '.mb_langSaved{font-size:11px;line-height:16px;color:var(--dsw-alias-state-success-primary)}' +
      '.mb_check{padding:8px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;display:flex;flex-direction:column;gap:4px;background:var(--dsw-alias-bg-layer-1,transparent)}';
    if (typeof document !== 'undefined') {
      const tagId = 'dsh-plugin-messaging/section.css'
      if (document.querySelector('style[data-plugin-css="' + tagId + '"]') === null) {
        const tag = document.createElement('style')
        tag.dataset.plugin = 'dsh-plugin-messaging'
        tag.dataset.pluginCss = tagId
        tag.textContent = css
        document.head.appendChild(tag)
      }
    }

    // ── option tables ────────────────────────────────────────────────────────
    const PLATFORMS = [
      { code: 'line', label: 'LINE' },
      { code: 'telegram', label: 'Telegram' },
      { code: 'whatsapp', label: 'WhatsApp' },
      { code: 'discord', label: 'Discord' },
    ]
    const LANGS = [
      { code: 'en', label: '🇬🇧 English' },
      { code: 'zh', label: '🇨🇳 中文 (Chinese)' },
      { code: 'th', label: '🇹🇭 ไทย (Thai)' },
    ]
    const BACKENDS = [
      { code: 'google', label: 'Google (ฟรี · ไม่ต้องมี key)' },
      { code: 'off', label: 'ปิด (ตอบตามภาษาเดิมของ AI)' },
    ]

    // Per-platform editable fields (path = deep path into the plugin Config).
    // The first entry of each channel is the "Keep the connection open" box: it is
    // read live by the bridge (index.js reconcile on loader/volatile-update), so
    // ticking it opens that channel and un-ticking closes it — no restart, no Save.
    const KEEP_OPEN = (name, detail) => ({
      path: null, // filled per platform below
      label: 'Keep the connection open',
      check: true,
      immediate: true,
      hint: `เปิด ${name} ให้รอข้อความเข้ามาตลอดเวลา แม้ไม่ได้เลือกเป็นแพลตฟอร์มหลัก · ติ๊ก/ถอดแล้วมีผลทันที (${detail})`,
    })
    const PLATFORM_FIELDS = {
      line: [
        { ...KEEP_OPEN('LINE', 'คง webhook route ของ LINE ไว้'), path: ['line', 'keepOpen'] },
        { path: ['line', 'channelAccessToken'], label: 'Channel access token', secret: true, placeholder: 'LINE Developers → Channel settings → Messaging API' },
        { path: ['line', 'channelSecret'], label: 'Channel secret', secret: true, placeholder: 'ใช้ตรวจลายเซ็น webhook (x-line-signature)' },
        { path: ['line', 'webhookPath'], label: 'Webhook path', placeholder: '/plugins/messaging/line/webhook' },
        { path: ['line', 'allowedGroupIds'], label: 'Group IDs (คั่นด้วย ,)', list: true },
        { path: ['line', 'allowedUserIds'], label: 'User IDs (คั่นด้วย ,)', list: true },
      ],
      telegram: [
        { ...KEEP_OPEN('Telegram', 'คง getUpdates (long-poll) ไว้'), path: ['telegram', 'keepOpen'] },
        { path: ['telegram', 'botToken'], label: 'Bot token', secret: true, placeholder: 'จาก @BotFather' },
        { path: ['telegram', 'receiveMode'], label: 'โหมดรับข้อความ', select: [{ code: 'longpoll', label: 'Long-poll (ไม่ต้องมี public URL)' }, { code: 'webhook', label: 'Webhook' }] },
        { path: ['telegram', 'allowedUserIds'], label: 'User IDs (คั่นด้วย ,)', list: true },
        { path: ['telegram', 'allowedChatIds'], label: 'Chat / Group IDs (คั่นด้วย ,)', list: true },
      ],
      whatsapp: [
        { ...KEEP_OPEN('WhatsApp', 'คง webhook route ของ Meta ไว้'), path: ['wa', 'keepOpen'] },
        { path: ['wa', 'accessToken'], label: 'Access token', secret: true },
        { path: ['wa', 'phoneNumberId'], label: 'Phone number ID' },
        { path: ['wa', 'appSecret'], label: 'App secret', secret: true, placeholder: 'ใช้ตรวจ X-Hub-Signature-256' },
        { path: ['wa', 'verifyToken'], label: 'Verify token (GET handshake)' },
        { path: ['wa', 'webhookPath'], label: 'Webhook path', placeholder: '/plugins/messaging/whatsapp/webhook' },
      ],
      discord: [],
    }

    // Secret config paths (must match the `.role('secret')` leaves in config.js).
    // The remote describe() redacts these, so we only ever WRITE one when the user
    // typed a non-empty value — a blank field must never wipe a stored secret.
    const SECRET_PATHS = new Set([
      'line.channelAccessToken', 'line.channelSecret',
      'telegram.botToken',
      'wa.accessToken', 'wa.appSecret',
    ])
    const isSecretPath = (path) => SECRET_PATHS.has((path || []).join('.'))

    // ── immutable deep-set helper ────────────────────────────────────────────
    function setPath(obj, path, value) {
      if (path.length === 0) return value
      const [head, ...rest] = path
      const clone = Array.isArray(obj) ? obj.slice() : { ...(obj || {}) }
      clone[head] = setPath(obj ? obj[head] : undefined, rest, value)
      return clone
    }
    const getPath = (obj, path) => path.reduce((o, k) => (o == null ? undefined : o[k]), obj)

    // Diff draft vs loaded into leaf-level mutate ops (arrays treated as leaves).
    // Recurses whenever either side is an object so we never emit a set for a whole
    // non-volatile container (e.g. `line`) — only for its volatile leaves. Secret
    // leaves are skipped when blank so an untouched/empty field never wipes them.
    function diffOps(loaded, draft, prefix, isSecret) {
      prefix = prefix || []
      const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v)
      if (isObj(loaded) || isObj(draft)) {
        const ops = []
        const keys = new Set([...Object.keys(loaded || {}), ...Object.keys(draft || {})])
        for (const key of keys) {
          ops.push(...diffOps(loaded ? loaded[key] : undefined, draft ? draft[key] : undefined, prefix.concat(key), isSecret))
        }
        return ops
      }
      if (JSON.stringify(loaded) === JSON.stringify(draft)) return []
      if (isSecret && isSecret(prefix) && (draft === undefined || draft === null || draft === '')) return []
      return [{ op: 'set', path: prefix, value: draft === undefined ? null : draft }]
    }

    // ── config controller ────────────────────────────────────────────────────
    // `commit(next)` writes an explicit draft rather than reading state, so a control
    // can save itself the moment the user touches it (`immediate` fields: the reply
    // language picker and the per-channel "Keep the connection open" boxes) — the
    // bridge reads those leaves live, so they take effect without a restart.
    function useConfig(settings) {
      const [state, setState] = useState({ status: 'loading' })
      const [draft, setDraft] = useState({})
      const live = useRef({ ns: null, revision: 0 })
      const draftRef = useRef({})
      const busy = useRef(false)
      const flash = (ms) => setTimeout(() => setState((s) => ({ ...s, saved: false })), ms)

      const load = useCallback(async () => {
        setState({ status: 'loading' })
        try {
          const res = await settings.describe()
          if (!res.ok) throw new Error(res.error?.message ?? 'describe failed')
          const doc = res.value
          const entry = (doc.namespaces || []).find(
            (n) => n && (n.ns === 'messaging-bridge' || (n.value && typeof n.value === 'object' && 'replyLanguage' in n.value && 'platform' in n.value)),
          )
          if (!entry) { setState({ status: 'ready', missing: true, writable: doc.writable !== false }); return }
          live.current = { ns: entry.ns, revision: entry.revision }
          const configured = new Set(((entry.secrets) || []).filter((s) => s && s.set).map((s) => (s.path || []).join('.')))
          draftRef.current = JSON.parse(JSON.stringify(entry.value || {}))
          setDraft(draftRef.current)
          setState({ status: 'ready', ns: entry.ns, writable: doc.writable !== false, saved: false, configured })
        } catch (e) {
          setState({ status: 'error', error: e?.message ?? String(e) })
        }
      }, [settings])

      useEffect(() => { void load() }, [load])

      const commit = useCallback(async (next) => {
        if (busy.current) return
        busy.current = true
        setState((s) => ({ ...s, saving: true, error: null }))
        try {
          const base = await settings.describe()
          const entry = ((base.value.namespaces) || []).find((n) => n && n.ns === live.current.ns)
          const ops = diffOps(entry ? entry.value : {}, next, [], isSecretPath)
          if (ops.length === 0) { setState((s) => ({ ...s, saving: false, saved: true })); flash(2000); return }
          const res = await settings.mutate(live.current.ns, ops, entry ? entry.revision : live.current.revision)
          if (!res.ok) throw new Error(res.error?.message ?? 'mutate failed')
          live.current.revision = res.value.revision
          const configured = new Set(((res.value.secrets) || []).filter((s) => s && s.set).map((s) => (s.path || []).join('.')))
          const merged = JSON.parse(JSON.stringify(res.value.value || next))
          draftRef.current = merged
          setDraft(merged)
          setState((s) => ({ ...s, saving: false, saved: true, configured }))
          flash(2500)
        } catch (e) {
          setState((s) => ({ ...s, saving: false, error: e?.message ?? String(e) }))
        } finally {
          busy.current = false
        }
      }, [settings])

      // edit(path, value) stages a change for the Save button; pass immediate to
      // write it straight away instead (controls the bridge reads live).
      const edit = useCallback((path, value, immediate) => {
        const next = setPath(draftRef.current || {}, path, value)
        draftRef.current = next
        setDraft(next)
        if (immediate) void commit(next)
      }, [commit])

      const save = useCallback(() => commit(draftRef.current || {}), [commit])

      return { state, draft, edit, save, load }
    }

    // ── controls ─────────────────────────────────────────────────────────────
    function Select({ value, options, onChange }) {
      return h('select', { className: 'mb_select', value: value ?? '', onChange: (e) => onChange(e.target.value) },
        options.map((o) => h('option', { key: o.code, value: o.code }, o.label)))
    }
    function Field({ label, hint, children }) {
      return h('div', { className: 'mb_field' },
        h('label', { className: 'mb_label' }, label),
        children,
        hint ? h('div', { className: 'mb_hint' }, hint) : null)
    }
    // Stop the browser / password managers from autofilling these config fields — a
    // saved password for this origin was leaking into the LINE/Telegram token box,
    // because secret fields render as type=password and Chrome treats them as a login.
    const antiFill = (secret) => ({
      autoComplete: secret ? 'new-password' : 'off',
      spellCheck: false,
      'data-1p-ignore': true,
      'data-lpignore': 'true',
      'data-keepass-ignore': true,
      'data-form-type': 'other',
    })
    function TextField({ field, value, onEdit, configured }) {
      // Checkbox row (the per-channel "Keep the connection open" box): saves itself
      // when the field is marked immediate, because the bridge reacts live.
      if (field.check) return h('div', { className: 'mb_check' },
        h(Toggle, { label: field.label, checked: !!value, onChange: (v) => onEdit(field.path, v, !!field.immediate) }),
        field.hint ? h('div', { className: 'mb_hint' }, field.hint) : null)
      if (field.select) return h(Field, { label: field.label, hint: field.hint }, h(Select, { value, options: field.select, onChange: (v) => onEdit(field.path, v) }))
      if (field.list) return h(Field, { label: field.label, hint: field.hint },
        h('input', { className: 'mb_input', value: (value || []).join(', '), placeholder: 'id1, id2', onChange: (e) => onEdit(field.path, e.target.value.split(',').map((s) => s.trim()).filter(Boolean)), ...antiFill(false) }))
      if (field.num) return h(Field, { label: field.label, hint: field.hint },
        h('input', { className: 'mb_input', type: 'number', value: value ?? 0, onChange: (e) => { const n = parseInt(e.target.value, 10); onEdit(field.path, isNaN(n) ? 0 : n) }, ...antiFill(false) }))
      const isSet = field.secret && configured && configured.has(field.path.join('.'))
      const ph = isSet && !value ? '••••••••  (ตั้งค่าแล้ว · เว้นว่างไว้เพื่อคงค่าเดิม)' : (field.placeholder || '')
      return h(Field, { label: field.label, hint: field.hint },
        h('input', { className: 'mb_input', type: field.secret ? 'password' : 'text', value: value ?? '', placeholder: ph, onChange: (e) => onEdit(field.path, e.target.value), ...antiFill(!!field.secret) }))
    }
    function Toggle({ label, checked, onChange, hint }) {
      return h('label', { className: 'mb_toggle' },
        h('input', { type: 'checkbox', checked: !!checked, onChange: (e) => onChange(e.target.checked) }),
        h('span', null, label),
        hint ? h('span', { className: 'mb_hint' }, '(' + hint + ')') : null)
    }
    function CheckGroup({ label, options, values, onToggle, hint }) {
      const set = new Set(values || [])
      return h('div', { className: 'mb_field' },
        label ? h('div', { className: 'mb_label' }, label) : null,
        h('div', { className: 'mb_row' }, options.map((o) =>
          h('label', { key: o.code, className: 'mb_toggle' },
            h('input', { type: 'checkbox', checked: set.has(o.code), onChange: () => onToggle(o.code) }),
            h('span', null, o.label)))),
        hint ? h('div', { className: 'mb_hint' }, hint) : null)
    }

    // ── section ──────────────────────────────────────────────────────────────
    function Section({ settings }) {
      const { state, draft, edit, save, load } = useConfig(settings)
      if (state.status === 'loading') return h('div', { className: 'mb_wrap' }, h('div', null, 'กำลังโหลด…'))
      if (state.status === 'error') return h('div', { className: 'mb_wrap' },
        h('div', { className: 'mb_err' }, 'อ่านค่าไม่สำเร็จ: ' + (state.error || '')),
        h('button', { className: 'mb_btn', onClick: () => void load() }, 'ลองใหม่'))
      if (state.missing) return h('div', { className: 'mb_wrap' },
        h('div', { className: 'mb_card' },
          h('div', { className: 'mb_pageTitle' }, 'Messaging'),
          h('div', { className: 'mb_hint' }, 'ยังไม่พบ namespace การตั้งค่าของปลั๊กอินนี้ — ตรวจสอบว่า dsh-plugin-messaging ถูกโหลดแล้ว (patch + restart)')))

      const platform = draft.platform || 'line'
      const fields = PLATFORM_FIELDS[platform] || []
      const langCode = draft.replyLanguage || 'en'

      return h('div', { className: 'mb_wrap' },
        // Header: plugin name on the left, reply-language menu top-right. Picking a
        // language writes it straight away (the bridge reads replyLanguage live).
        h('div', { className: 'mb_card' },
          h('div', { className: 'mb_head' },
            h('div', null,
              h('div', { className: 'mb_pageTitle' }, 'Messaging bridge'),
              h('div', { className: 'mb_cardDesc' }, 'เชื่อมแชท (LINE / Telegram / WhatsApp) เข้ากับ session ของ DSH · นับจำนวนข้อความรายเดือน')),
            h('div', { className: 'mb_lang' },
              h('label', { className: 'mb_label' }, '🌐 ภาษาแสดงผล (ภาษาตอบกลับ)'),
              h(Select, { value: langCode, options: LANGS, onChange: (v) => edit(['replyLanguage'], v, true) }),
              h('div', { className: state.saved ? 'mb_langSaved' : 'mb_hint' },
                state.saved
                  ? '✓ เปลี่ยนภาษาแล้ว · มีผลกับคำตอบถัดไปทันที'
                  : 'เลือกแล้วบันทึกอัตโนมัติ · แชตที่เคยพิมพ์ /lang ไว้จะยึดภาษานั้นก่อน')))),

        h('div', { className: 'mb_card' },
          h('div', { className: 'mb_cardTitle' }, 'ทั่วไป'),
          h(Toggle, { label: 'เปิดใช้ bridge (ปิดแล้วทุกช่องทางจะปิดการเชื่อมต่อทันที)', checked: draft.enabled, onChange: (v) => edit(['enabled'], v, true) }),
          h('div', { className: 'mb_row' },
            h(Field, { label: 'แพลตฟอร์ม' }, h(Select, { value: platform, options: PLATFORMS, onChange: (v) => edit(['platform'], v) })),
            h(Field, { label: 'เอนจินแปลภาษา' }, h(Select, { value: draft.translateBackend || 'google', options: BACKENDS, onChange: (v) => edit(['translateBackend'], v) })))),

        fields.length > 0
          ? h('div', { className: 'mb_card' },
              h('div', { className: 'mb_cardTitle' }, 'การตั้งค่า ' + (PLATFORMS.find((p) => p.code === platform) || {}).label),
              platform !== 'telegram' ? h('div', { className: 'mb_hint' }, 'DSH ผูกเฉพาะ localhost ไม่มี TLS — แพลตฟอร์มแบบ webhook ต้องมี public HTTPS (tunnel / reverse proxy) ชี้มาที่ webhook path') : null,
              fields.map((f) => h(TextField, { key: f.path.join('.'), field: f, value: getPath(draft, f.path), onEdit: edit, configured: state.configured })))
          : h('div', { className: 'mb_card' },
              h('div', { className: 'mb_cardTitle' }, 'Discord'),
              h('div', { className: 'mb_hint' }, 'Discord ใช้ปลั๊กอิน dsh-plugin-discord แยกต่างหาก — bridge นี้ไม่ซ้ำซ้อน (เลือกเพื่ออ้างอิงเท่านั้น)')),

        h('div', { className: 'mb_card' },
          h('div', { className: 'mb_cardTitle' }, 'ขั้นสูง'),
          h('div', { className: 'mb_row' },
            h(TextField, { field: { path: ['maxCharsPerMessage'], label: 'ตัวอักษร/ข้อความ (budget)', num: true }, value: draft.maxCharsPerMessage, onEdit: edit }),
            h(TextField, { field: { path: ['maxChunksPerReply'], label: 'ข้อความสูงสุด/คำตอบ', num: true }, value: draft.maxChunksPerReply, onEdit: edit })),
          h(TextField, { field: { path: ['publicBaseUrl'], label: 'Public base URL (สำหรับ webhook)', placeholder: 'https://xxx.example.com · ว่างได้ถ้าใช้ long-poll' }, value: draft.publicBaseUrl, onEdit: edit }),
          h('div', { className: 'mb_row' },
            h(Toggle, { label: 'นับจำนวนข้อความรายเดือน', checked: draft.counterEnabled, onChange: (v) => edit(['counterEnabled'], v) }),
            h(Toggle, { label: 'ท้ายข้อความ (เวลา · t/s)', checked: draft.showStatsFooter, onChange: (v) => edit(['showStatsFooter'], v) }),
            h(Toggle, { label: 'loading indicator (LINE 1:1)', checked: draft.loadingIndicator, onChange: (v) => edit(['loadingIndicator'], v) }))),

        h('div', { className: 'mb_card' },
          h('div', { className: 'mb_cardTitle' }, 'Broadcast Messages'),
          h('div', { className: 'mb_cardDesc' }, 'คัดลอกคำตอบของ AI ไปยังช่องทางอื่นแบบทางเดียว · เปิดแล้วทุกช่องทางที่ใส่ credential จะทำงานพร้อมกัน (สลับได้โดยไม่ต้องรีสตาร์ท)'),
          h(Toggle, { label: 'เปิดใช้ Broadcast', checked: draft.broadcast?.enabled, onChange: (v) => edit(['broadcast', 'enabled'], v, true) }),
          ...(draft.broadcast?.enabled ? [
            h(CheckGroup, {
              key: 'bc-targets',
              label: 'คัดลอกคำตอบไปยัง',
              options: PLATFORMS.filter((p) => p.code !== 'discord'),
              values: draft.broadcast?.platforms || [],
              onToggle: (code) => { const cur = new Set(draft.broadcast?.platforms || []); if (cur.has(code)) cur.delete(code); else cur.add(code); edit(['broadcast', 'platforms'], [...cur]) },
              hint: 'ช่องทางปลายทาง (ยกเว้นช่องทางที่กำลังถามอยู่)',
            }),
            h(Toggle, { key: 'bc-share', label: 'แชร์ session เดียวกันทุกช่องทาง', checked: draft.broadcast?.shareSession, onChange: (v) => edit(['broadcast', 'shareSession'], v), hint: 'ทุกช่องทางเข้า session เดียวกัน + ใส่ป้าย [MSG-<TAG>] กำกับข้อความ' }),
          ] : [])),

        h('div', { className: 'mb_footer' },
          h('button', { className: 'mb_btn', disabled: state.saving || state.writable === false, onClick: () => void save() }, state.saving ? 'บันทึก…' : 'บันทึก'),
          h('button', { className: 'mb_btn mb_btnGhost', onClick: () => void load() }, 'โหลดใหม่'),
          state.saved ? h('span', { className: 'mb_saved' }, '✓ บันทึกแล้ว') : null,
          state.error ? h('span', { className: 'mb_err' }, 'บันทึกไม่สำเร็จ: ' + state.error) : null),
        h('div', { className: 'mb_hint' }, 'มีผลทันทีโดยไม่ต้องรีสตาร์ท: ภาษาตอบกลับ · Keep the connection open · Broadcast · ค่าขั้นสูง (ช่องที่เปิดใช้ bridge: ปิดแล้วปิดทันที แต่ถ้าปิดไว้ตั้งแต่ก่อนสตาร์ท ต้องรีสตาร์ทหนึ่งครั้งเพื่อเปิดใหม่) · ส่วน token / allowlist / โหมดรับข้อความ ต้องบันทึกแล้วรีสตาร์ทปลั๊กอินก่อน · ความลับเก็บใน settings.yaml (หรือใช้ env ผ่าน *Env field)'))
    }

    function apply(ctx) {
      // The Host settings remote — the same transport the built-in Settings pages
      // use (dsh-client-ui-settings). NOT connection.api: the client `api` object
      // has no `settings` namespace here.
      //   settings.describe()            -> { ok, value: { namespaces, writable }, error }
      //   settings.mutate(ns, ops, rev)  -> { ok, value: <namespace view>, error }  (positional)
      const settings = ctx.remote.settings
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: 'messaging',
            order: 55,
            label: () => 'Messaging',
            inject: () => ({ settings }),
          },
          Section,
        ),
      )
    }

    exports.apply = apply
    exports.inject = ['slots', 'remote', 'remote.settings']
    // Test seam only — the Host reads just `apply` / `inject`; extra exports are
    // ignored. Exposes the pure form helpers so the write path can be unit-tested.
    exports.__internals = { diffOps, isSecretPath, setPath, getPath, PLATFORM_FIELDS, LANGS, PLATFORMS }
    return module.exports
  },
})
