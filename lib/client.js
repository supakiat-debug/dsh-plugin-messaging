// dsh-plugin-messaging — browser half (prebuilt client bundle, no build step).
//
// Registers a `settings.section` page ("Messaging") that edits this plugin's own
// Config through the host settings RPC (`settings/describe` + `settings/mutate`):
//   - header row: plugin name on the left, language menu (en / 中文 / ไทย)
//     top-right — picking a language writes it at once (no Save, no restart) AND
//     repaints this whole page in that language (every string comes from `STR`)
//   - platform picker (LINE / Telegram / WhatsApp / Discord / Messenger) + translate
//     backend
//   - per-platform credential / group / webhook fields; each card is led by a
//     "Keep the connection open" box that opens/closes that channel live (index.js)
//   - broadcast card: one-way copy of every AI reply to the other channels
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
      '.mb_lang{display:flex;flex-direction:column;gap:4px;flex:none;width:250px}' +
      '.mb_langSaved{font-size:11px;line-height:16px;color:var(--dsw-alias-state-success-primary)}' +
      '.mb_langWarn{font-size:11px;line-height:16px;color:var(--dsw-alias-state-warning-primary)}' +
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

    // ── page language ────────────────────────────────────────────────────────
    // The 🌐 menu is `replyLanguage`, and it is ALSO the language this page is
    // drawn in: every visible string is looked up in `STR` below, so picking a
    // language repaints the settings page immediately (the value is volatile, so
    // the bridge reads the same new value live — no restart, no Save button).
    // Column order: [ไทย, English, 中文] — index 0 is the default for tests.
    const STR = {
      loading: ['กำลังโหลด…', 'Loading…', '正在加载…'],
      readFailed: ['อ่านค่าไม่สำเร็จ', 'Could not read the settings', '读取设置失败'],
      retry: ['ลองใหม่', 'Try again', '重试'],
      notFound: [
        'ยังไม่พบ namespace การตั้งค่าของปลั๊กอินนี้ — ตรวจสอบว่า dsh-plugin-messaging ถูกโหลดแล้ว (patch + restart)',
        'This plugin’s settings namespace was not found — check that dsh-plugin-messaging is loaded (patch + restart)',
        '未找到此插件的设置命名空间 — 请确认 dsh-plugin-messaging 已加载（patch + 重启）',
      ],
      bridgeDesc: [
        'เชื่อมแชท (LINE / Telegram / WhatsApp / Discord / Messenger) เข้ากับ session ของ DSH · นับจำนวนข้อความรายเดือน',
        'Connect chat apps (LINE / Telegram / WhatsApp / Discord / Messenger) to your DSH sessions · monthly message counter',
        '把聊天应用（LINE / Telegram / WhatsApp / Discord / Messenger）接入 DSH 会话 · 每月消息计数',
      ],
      langLabel: ['🌐 ภาษาแสดงผล (ภาษาตอบกลับ)', '🌐 Display language (reply language)', '🌐 显示语言（回复语言）'],
      langSaved: [
        '✓ เปลี่ยนภาษาแล้ว · หน้านี้และข้อความของ bridge ใช้ภาษานี้ทันที',
        '✓ Language changed · this page and the bridge’s own messages follow it at once',
        '✓ 已切换语言 · 本页面和 bridge 自身的消息立即使用此语言',
      ],
      langHint: [
        'เลือกแล้วบันทึกอัตโนมัติ · แชตที่เคยพิมพ์ /lang ไว้จะยึดภาษานั้นก่อน',
        'Picking saves automatically · chats where you typed /lang keep that language first',
        '选择即自动保存 · 之前输入过 /lang 的聊天优先使用该语言',
      ],
      langOff: [
        'เอนจินแปลภาษาตั้งเป็น “ปิด” อยู่ → ข้อความของ bridge (สถานะ · ข้อผิดพลาด · คำตอบคำสั่ง) จะคงภาษาเดิม ส่วนคำตอบที่ AI เขียนส่งตามต้นฉบับเสมอ ไม่ถูกแปล · เลือก Google ถ้าอยากให้ bridge พูดภาษาที่เลือก',
        'The translation engine is set to “off”, so the bridge’s own messages (status · errors · command replies) stay in their original language · the text the AI writes is always sent verbatim and is never translated · pick Google if the bridge should speak the language you chose',
        '翻译引擎为“关闭” → bridge 自身的消息（状态 · 错误 · 命令回复）保持原语言 · AI 写出的内容始终原样发送、从不翻译 · 如需 bridge 使用你所选的语言，请选择 Google',
      ],
      general: ['ทั่วไป', 'General', '常规'],
      enabledLabel: [
        'เปิดใช้ bridge (ปิดแล้วทุกช่องทางจะปิดการเชื่อมต่อทันที)',
        'Enable bridge (turning it off closes every connection immediately)',
        '启用 bridge（关闭后立即断开所有连接）',
      ],
      platformLabel: ['แพลตฟอร์ม', 'Platform', '平台'],
      engineLabel: ['เอนจินแปลภาษา', 'Translation engine', '翻译引擎'],
      engineGoogle: ['Google (ฟรี · ไม่ต้องมี key)', 'Google (free · no key needed)', 'Google（免费 · 无需 key）'],
      engineOff: ['ปิด (ตอบตามภาษาเดิมของ AI)', 'Off (answer in the AI’s own language)', '关闭（按 AI 原本语言回复）'],
      chanSettings: ['การตั้งค่า {n}', '{n} settings', '{n} 设置'],
      webhookNote: [
        'DSH ผูกเฉพาะ localhost ไม่มี TLS — แพลตฟอร์มแบบ webhook ต้องมี public HTTPS (tunnel / reverse proxy) ชี้มาที่ webhook path',
        'DSH listens on localhost only (no TLS) — webhook platforms need a public HTTPS URL (tunnel / reverse proxy) pointing at the webhook path',
        'DSH 仅监听 localhost（无 TLS）— webhook 平台需要公网 HTTPS（隧道 / 反向代理）指向 webhook 路径',
      ],
      discordNote: [
        'Discord ใช้ WebSocket แบบ "มุ่งออก" จึงไม่ต้องเปิดพอร์ต ไม่ต้องมี URL สาธารณะ และไม่ต้องมีอุโมงค์ — สร้าง Application + Bot ใน Developer Portal, ชวนบอทเข้าเซิร์ฟเวอร์ด้วย scope bot (View Channels / Send Messages / Read Message History), เปิด MESSAGE CONTENT intent แล้ววาง Bot token ที่นี่ ในเซิร์ฟเวอร์จะตอบเฉพาะเมื่อถูก @mention (แชทส่วนตัวตอบเสมอ)',
        'Discord connects with an OUTBOUND WebSocket, so it needs no public URL, no open port and no tunnel — create an Application + Bot in the Developer Portal, invite it to your server with the bot scope (View Channels / Send Messages / Read Message History), turn on the MESSAGE CONTENT intent, then paste the Bot token here. In servers it answers only when @mentioned (DMs always answer).',
        'Discord 使用“出站” WebSocket，无需公网 URL、开放端口或隧道 — 在 Developer Portal 创建 Application + Bot，以 bot scope 邀请进服务器（View Channels / Send Messages / Read Message History），开启 MESSAGE CONTENT intent，然后粘贴 Bot token。服务器内需 @提及才回复（私聊总是回复）。',
      ],
      discordWarn: [
        'token ของบอท Discord รับได้หนึ่ง gateway connection ต่อครั้ง — ถ้ารัน dsh-plugin-discord ควบคู่กันด้วย token เดียวกัน ข้อความจะถูกตอบซ้ำสองรอบ เลือกใช้ตัวใดตัวหนึ่ง',
        'A Discord bot token holds one gateway connection at a time — if dsh-plugin-discord runs with the same token, both bridges answer every message twice. Pick one plugin per token.',
        '同一个 Discord bot token 一次只能维持一个 gateway connection — 若与 dsh-plugin-discord 同时使用同一个 token，同一条消息会被回复两次，请只用其中一个插件',
      ],
      messengerNote: [
        'Messenger (Meta Graph API) ต้องมี webhook สาธารณะแบบ HTTPS — เปิดผลิตภัณฑ์ Messenger ให้ Page ของคุณ, เอา URL ของ DSH ไปใส่ใน App Dashboard แล้ว subscribe ฟิลด์ "messages", ตั้ง Verify token ให้ตรงกับช่องด้านล่าง และ mint Page access token ที่มี scope pages_messaging',
        'Messenger (Meta Graph API) needs a public HTTPS webhook — enable the Messenger product for your Page, paste this DSH URL into the App Dashboard and subscribe the "messages" field, set the Verify token to match the field below, and mint a Page access token with the pages_messaging scope.',
        'Messenger（Meta Graph API）需要公网 HTTPS webhook — 为你的 Page 开启 Messenger 产品，把此 DSH URL 填入 App Dashboard 并订阅 “messages” 字段，Verify token 需与下方一致，并取得含 pages_messaging scope 的 Page access token。',
      ],
      windowNote: [
        'Meta บล็อกข้อความที่ bridge เริ่มเองหลังผู้ใช้งานทักมาครบ 24 ชั่วโมง (error #10 / subcode 551) — ตั้ง Message tag สำรอง (เช่น HUMAN_AGENT) ไว้ถ้าต้องส่งนอกหน้าต่างนั้น',
        'Meta blocks replies the bridge starts more than 24 hours after the user last wrote (error #10 / subcode 551) — set a fallback Message tag (e.g. HUMAN_AGENT) if you must send outside that window.',
        '用户最后一次来信超过 24 小时后，Meta 会拦截 bridge 主动发送的消息（error #10 / subcode 551）— 如需在该窗口外发送，请设置备用 Message tag（如 HUMAN_AGENT）。',
      ],
      advanced: ['ขั้นสูง', 'Advanced', '高级'],
      maxChars: ['ตัวอักษร/ข้อความ (budget)', 'Characters per message (budget)', '每条消息字符数（预算）'],
      maxChunks: ['ข้อความสูงสุด/คำตอบ', 'Max messages per reply', '每次回复最多消息数'],
      publicUrl: ['Public base URL (สำหรับ webhook)', 'Public base URL (for webhooks)', '公网 base URL（用于 webhook）'],
      publicUrlPh: [
        'https://xxx.example.com · ว่างได้ถ้าใช้ long-poll',
        'https://xxx.example.com · leave empty for long-poll',
        'https://xxx.example.com · 使用 long-poll 可留空',
      ],
      counterLabel: ['นับจำนวนข้อความรายเดือน', 'Count messages monthly', '按月统计消息数'],
      statsLabel: ['ท้ายข้อความ (เวลา · t/s)', 'Stats footer (time · t/s)', '消息尾注（时间 · t/s）'],
      loadingLabel: ['loading indicator (LINE 1:1)', 'Loading indicator (LINE 1:1)', '输入提示（LINE 1:1）'],
      bcTitle: ['Broadcast Messages', 'Broadcast Messages', 'Broadcast Messages'],
      bcDesc: [
        'คัดลอกคำตอบของ AI ไปยังช่องทางอื่นแบบทางเดียว · เปิดแล้วทุกช่องทางที่ใส่ credential จะทำงานพร้อมกัน (สลับได้โดยไม่ต้องรีสตาร์ท)',
        'One-way copy of AI replies to other channels · when enabled, every channel with credentials runs at once (switch without restarting)',
        '单向把 AI 回复复制到其他渠道 · 启用后所有已配置凭据的渠道同时运行（切换无需重启）',
      ],
      bcEnabled: ['เปิดใช้ Broadcast', 'Enable Broadcast', '启用 Broadcast'],
      bcTargets: ['คัดลอกคำตอบไปยัง', 'Copy replies to', '复制回复到'],
      bcTargetsHint: [
        'ช่องทางปลายทาง (ยกเว้นช่องทางที่กำลังถามอยู่)',
        'Target channels (except the one being asked)',
        '目标渠道（正在提问的除外）',
      ],
      bcShare: ['แชร์ session เดียวกันทุกช่องทาง', 'Share one session across all channels', '所有渠道共享同一会话'],
      bcShareHint: [
        'ทุกช่องทางเข้า session เดียวกัน + ใส่ป้าย [MSG-<TAG>] กำกับข้อความ',
        'All channels use one session and each message is tagged [MSG-<TAG>]',
        '所有渠道进入同一会话，并为消息加 [MSG-<TAG>] 标记',
      ],
      save: ['บันทึก', 'Save', '保存'],
      saving: ['บันทึก…', 'Saving…', '保存中…'],
      reload: ['โหลดใหม่', 'Reload', '重新加载'],
      savedOk: ['✓ บันทึกแล้ว', '✓ Saved', '✓ 已保存'],
      saveFailed: ['บันทึกไม่สำเร็จ', 'Save failed', '保存失败'],
      footerHint: [
        'มีผลทันทีโดยไม่ต้องรีสตาร์ท: ภาษา · Keep the connection open · เปิดใช้ bridge · Broadcast · ค่าขั้นสูง (ถ้าปิด bridge ไว้ตั้งแต่ก่อนสตาร์ท ต้องรีสตาร์ทหนึ่งครั้งเพื่อเปิดใหม่) · ส่วน token / allowlist / โหมดรับข้อความ ต้องบันทึกแล้วรีสตาร์ทปลั๊กอินก่อน · ความลับเก็บใน settings.yaml (หรือใช้ env ผ่าน *Env field)',
        'Live without a restart: language · “Keep the connection open” · enabling the bridge · Broadcast · advanced values (if the bridge was already off at boot it needs one restart to come back on) · tokens, allowlists and the receive mode still need a plugin restart after saving · secrets live in settings.yaml (or use env through the *Env field)',
        '无需重启即生效：语言 · “Keep the connection open” · 启用 bridge · Broadcast · 高级项（若启动前 bridge 已关闭，需重启一次才能恢复）· token、白名单、接收模式保存后仍需重启插件 · 密钥保存在 settings.yaml（或通过 *Env 字段使用环境变量）',
      ],
      secretSetPh: [
        '••••••••  (ตั้งค่าแล้ว · เว้นว่างไว้เพื่อคงค่าเดิม)',
        '••••••••  (already set · leave blank to keep it)',
        '••••••••  （已设置 · 留空则保持原值）',
      ],
      // Keep the connection open — the checkbox keeps its English product name in
      // every language (that is the wording the user asked for); only the hint
      // translates. Thai must keep the words "มีผลทันที" (applies immediately).
      keepLabel: ['Keep the connection open', 'Keep the connection open', 'Keep the connection open'],
      keepOpenHint: [
        'เปิด {n} ให้รอข้อความเข้ามาตลอดเวลา แม้ไม่ได้เลือกเป็นแพลตฟอร์มหลัก · ติ๊ก/ถอดแล้วมีผลทันที ({d})',
        'Keep {n} listening for incoming messages even when it is not the primary platform · toggling applies at once ({d})',
        '即使 {n} 不是主平台，也持续等待来信 · 勾选/取消立即生效（{d}）',
      ],
      keepLineDetail: [
        'คง webhook route ของ LINE ไว้',
        'keeps the LINE webhook route registered',
        '保持 LINE webhook 路由注册',
      ],
      keepTgDetail: [
        'คง getUpdates (long-poll) ไว้',
        'keeps getUpdates (long-poll) running',
        '保持 getUpdates（long-poll）运行',
      ],
      keepWaDetail: [
        'คง webhook route ของ Meta ไว้',
        'keeps the Meta webhook route registered',
        '保持 Meta webhook 路由注册',
      ],
      keepDcDetail: [
        'คงการเชื่อมต่อ Discord gateway ไว้',
        'keeps the Discord gateway connection open',
        '保持 Discord 网关连接开启',
      ],
      keepMsDetail: [
        'คง webhook route ของ Messenger ไว้',
        'keeps the Messenger webhook route registered',
        '保持 Messenger webhook 路由注册',
      ],
      // Discord / Messenger field labels that are not plain technical names.
      messageContentIntent: [
        'MESSAGE CONTENT intent (สิทธิ์พิเศษ · ต้องเปิดใน Developer Portal)',
        'MESSAGE CONTENT intent (privileged · also enable it in the Developer Portal)',
        'MESSAGE CONTENT intent（特权 intent · 同时需在 Developer Portal 开启）',
      ],
      requireMention: [
        'ในเซิร์ฟเวอร์: ตอบเมื่อถูก @mention เท่านั้น',
        'In servers: answer only when @mentioned',
        '服务器内：仅在被 @提及 时回复',
      ],
      editLiveStatus: [
        'แก้ข้อความ "กำลังคิด…" แทนการส่งใหม่ (แก้ไขได้เท่านั้น)',
        'Edit the "thinking…" message instead of sending new ones (editable platforms only)',
        '原地编辑“正在思考…”消息而非另发（仅限可编辑平台）',
      ],
      typingIndicator: ['แสดงสถานะกำลังพิมพ์', 'Show the typing indicator', '显示输入状态'],
      channelIds: ['Channel IDs (คั่นด้วย ,)', 'Channel IDs (comma separated)', '频道 ID（逗号分隔）'],
      guildIds: ['Server (guild) IDs (คั่นด้วย ,)', 'Server (guild) IDs (comma separated)', '服务器 (guild) ID（逗号分隔）'],
      pageToken: ['Page access token', 'Page access token', 'Page access token'],
      pageTokenPh: [
        'จาก Messenger → Settings → Token for Page (scope pages_messaging)',
        'from Messenger → Settings → Token for Page (scope pages_messaging)',
        '来自 Messenger → Settings → Token for Page（scope pages_messaging）',
      ],
      pageIdPh: [
        'ว่างได้ — จะส่งผ่าน /me ซึ่งชี้ไป Page ของ token เอง',
        'leave empty — sends through /me, which resolves to the token’s own Page',
        '可留空 — 将通过 /me 发送，即 token 所属的 Page',
      ],
      graphVersion: ['Graph API version', 'Graph API version', 'Graph API 版本'],
      outOfWindowTag: [
        'Message tag เมื่อพ้นหน้าต่าง 24 ชม.',
        'Message tag once the 24-hour window has closed',
        '超出 24 小时窗口时使用的 message tag',
      ],
      tagNone: ['— ไม่ใช้ —', '— none —', '— 无 —'],
      // Field labels / placeholders that are not plain technical names.
      groupIds: ['Group IDs (คั่นด้วย ,)', 'Group IDs (comma separated)', '群组 ID（逗号分隔）'],
      userIds: ['User IDs (คั่นด้วย ,)', 'User IDs (comma separated)', '用户 ID（逗号分隔）'],
      chatIds: ['Chat / Group IDs (คั่นด้วย ,)', 'Chat / Group IDs (comma separated)', '会话 / 群组 ID（逗号分隔）'],
      receiveMode: ['โหมดรับข้อความ', 'Message receive mode', '接收消息方式'],
      modeLongpoll: [
        'Long-poll (ไม่ต้องมี public URL)',
        'Long-poll (no public URL needed)',
        'Long-poll（无需公网 URL）',
      ],
      modeWebhook: ['Webhook', 'Webhook', 'Webhook'],
      tgTokenPh: ['จาก @BotFather', 'from @BotFather', '来自 @BotFather'],
      lineSecretPh: [
        'ใช้ตรวจลายเซ็น webhook (x-line-signature)',
        'verifies the webhook signature (x-line-signature)',
        '用于校验 webhook 签名（x-line-signature）',
      ],
      waSecretPh: ['ใช้ตรวจ X-Hub-Signature-256', 'verifies X-Hub-Signature-256', '用于校验 X-Hub-Signature-256'],
      appSecret: ['App secret', 'App secret', 'App 密钥'],
      verifyToken: ['Verify token (GET handshake)', 'Verify token (GET handshake)', 'Verify token（GET 握手）'],
      webhookPath: ['Webhook path', 'Webhook path', 'Webhook 路径'],
      phoneId: ['Phone number ID', 'Phone number ID', 'Phone number ID'],
      accessToken: ['Access token', 'Access token', 'Access token'],
      botToken: ['Bot token', 'Bot token', 'Bot token'],
      lineToken: ['Channel access token', 'Channel access token', 'Channel access token'],
      lineTokenPh: [
        'LINE Developers → Channel settings → Messaging API',
        'LINE Developers → Channel settings → Messaging API',
        'LINE Developers → Channel settings → Messaging API',
      ],
    }

    // 0 = ไทย, 1 = English (schema default), 2 = 中文.
    const langIdx = (code) => (code === 'th' ? 0 : code === 'zh' ? 2 : 1)
    const makeT = (code) => {
      const i = langIdx(code)
      return (id, vars) => {
        const row = STR[id]
        let s = row ? row[i] : id
        if (vars) for (const k of Object.keys(vars)) s = s.split('{' + k + '}').join(vars[k])
        return s
      }
    }

    // ── option tables ────────────────────────────────────────────────────────
    const PLATFORMS = [
      { code: 'line', label: 'LINE' },
      { code: 'telegram', label: 'Telegram' },
      { code: 'whatsapp', label: 'WhatsApp' },
      { code: 'discord', label: 'Discord' },
      { code: 'messenger', label: 'Messenger' },
    ]
    // Language names stay in their own script — that is how a picker self-identifies.
    const LANGS = [
      { code: 'en', label: '🇬🇧 English' },
      { code: 'zh', label: '🇨🇳 中文 (Chinese)' },
      { code: 'th', label: '🇹🇭 ไทย (Thai)' },
    ]
    const backends = (t) => [
      { code: 'google', label: t('engineGoogle') },
      { code: 'off', label: t('engineOff') },
    ]

    // Per-platform editable fields (path = deep path into the plugin Config).
    // The first entry of each channel is the "Keep the connection open" box: it is
    // read live by the bridge (index.js reconcile on loader/volatile-update), so
    // ticking it opens that channel and un-ticking closes it — no restart, no Save.
    const KEEP_OPEN = (t, name, detailId) => ({
      path: null, // filled per platform below
      label: t('keepLabel'),
      check: true,
      immediate: true,
      hint: t('keepOpenHint', { n: name, d: t(detailId) }),
    })
    const platformFields = (t) => ({
      line: [
        { ...KEEP_OPEN(t, 'LINE', 'keepLineDetail'), path: ['line', 'keepOpen'] },
        { path: ['line', 'channelAccessToken'], label: t('lineToken'), secret: true, placeholder: t('lineTokenPh') },
        { path: ['line', 'channelSecret'], label: 'Channel secret', secret: true, placeholder: t('lineSecretPh') },
        { path: ['line', 'webhookPath'], label: t('webhookPath'), placeholder: '/plugins/messaging/line/webhook' },
        { path: ['line', 'allowedGroupIds'], label: t('groupIds'), list: true },
        { path: ['line', 'allowedUserIds'], label: t('userIds'), list: true },
      ],
      telegram: [
        { ...KEEP_OPEN(t, 'Telegram', 'keepTgDetail'), path: ['telegram', 'keepOpen'] },
        { path: ['telegram', 'botToken'], label: t('botToken'), secret: true, placeholder: t('tgTokenPh') },
        {
          path: ['telegram', 'receiveMode'], label: t('receiveMode'),
          select: [{ code: 'longpoll', label: t('modeLongpoll') }, { code: 'webhook', label: t('modeWebhook') }],
        },
        { path: ['telegram', 'allowedUserIds'], label: t('userIds'), list: true },
        { path: ['telegram', 'allowedChatIds'], label: t('chatIds'), list: true },
      ],
      whatsapp: [
        { ...KEEP_OPEN(t, 'WhatsApp', 'keepWaDetail'), path: ['wa', 'keepOpen'] },
        { path: ['wa', 'accessToken'], label: t('accessToken'), secret: true },
        { path: ['wa', 'phoneNumberId'], label: t('phoneId') },
        { path: ['wa', 'appSecret'], label: t('appSecret'), secret: true, placeholder: t('waSecretPh') },
        { path: ['wa', 'verifyToken'], label: t('verifyToken') },
        { path: ['wa', 'webhookPath'], label: t('webhookPath'), placeholder: '/plugins/messaging/whatsapp/webhook' },
      ],
      discord: [
        { ...KEEP_OPEN(t, 'Discord', 'keepDcDetail'), path: ['discord', 'keepOpen'] },
        {
          path: ['discord', 'botToken'], label: t('botToken'), secret: true,
          placeholder: 'Developer Portal → Applications → Bot → Reset Token',
        },
        { path: ['discord', 'messageContentIntent'], label: t('messageContentIntent'), check: true },
        { path: ['discord', 'requireMentionInGuild'], label: t('requireMention'), check: true },
        { path: ['discord', 'editLiveStatus'], label: t('editLiveStatus'), check: true },
        { path: ['discord', 'allowedUserIds'], label: t('userIds'), list: true },
        { path: ['discord', 'allowedChannelIds'], label: t('channelIds'), list: true },
        { path: ['discord', 'allowedGuildIds'], label: t('guildIds'), list: true },
      ],
      messenger: [
        { ...KEEP_OPEN(t, 'Messenger', 'keepMsDetail'), path: ['messenger', 'keepOpen'] },
        { path: ['messenger', 'pageAccessToken'], label: t('pageToken'), secret: true, placeholder: t('pageTokenPh') },
        { path: ['messenger', 'pageId'], label: 'Page ID', placeholder: t('pageIdPh') },
        { path: ['messenger', 'verifyToken'], label: t('verifyToken') },
        // Same X-Hub-Signature-256 scheme as WhatsApp, so the same hint text fits.
        { path: ['messenger', 'appSecret'], label: t('appSecret'), secret: true, placeholder: t('waSecretPh') },
        { path: ['messenger', 'graphVersion'], label: t('graphVersion'), placeholder: 'v24.0' },
        {
          path: ['messenger', 'outOfWindowTag'], label: t('outOfWindowTag'),
          select: [
            { code: '', label: t('tagNone') },
            { code: 'HUMAN_AGENT', label: 'HUMAN_AGENT' },
            { code: 'ACCOUNT_UPDATE', label: 'ACCOUNT_UPDATE' },
            { code: 'CONFIRMED_EVENT_UPDATE', label: 'CONFIRMED_EVENT_UPDATE' },
            { code: 'POST_PURCHASE_UPDATE', label: 'POST_PURCHASE_UPDATE' },
          ],
        },
        { path: ['messenger', 'typingIndicator'], label: t('typingIndicator'), check: true },
        { path: ['messenger', 'allowedUserIds'], label: t('userIds'), list: true },
        { path: ['messenger', 'webhookPath'], label: t('webhookPath'), placeholder: '/plugins/messaging/messenger/webhook' },
      ],
    })
    // Thai-built table: the export seam for tests / anyone importing the field map.
    const PLATFORM_FIELDS = platformFields(makeT('th'))

    // Secret config paths (must match the `.role('secret')` leaves in config.js).
    // The remote describe() redacts these, so we only ever WRITE one when the user
    // typed a non-empty value — a blank field must never wipe a stored secret.
    const SECRET_PATHS = new Set([
      'line.channelAccessToken', 'line.channelSecret',
      'telegram.botToken',
      'wa.accessToken', 'wa.appSecret',
      'discord.botToken',
      'messenger.pageAccessToken', 'messenger.appSecret',
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
    // can save itself the moment the user touches it (`immediate` fields: the language
    // picker and the per-channel "Keep the connection open" boxes) — the bridge reads
    // those leaves live, so they take effect without a restart.
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
    function TextField({ field, value, onEdit, configured, t }) {
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
      const ph = isSet && !value ? t('secretSetPh') : (field.placeholder || '')
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
      // The page language follows the saved/typed replyLanguage at once: `edit`
      // updates the draft before the write comes back, so the repaint is instant.
      const langCode = draft.replyLanguage || 'en'
      const t = makeT(langCode)
      const offEngine = (draft.translateBackend || 'google') === 'off'

      if (state.status === 'loading') return h('div', { className: 'mb_wrap' }, h('div', null, t('loading')))
      if (state.status === 'error') return h('div', { className: 'mb_wrap' },
        h('div', { className: 'mb_err' }, t('readFailed') + ': ' + (state.error || '')),
        h('button', { className: 'mb_btn', onClick: () => void load() }, t('retry')))
      if (state.missing) return h('div', { className: 'mb_wrap' },
        h('div', { className: 'mb_card' },
          h('div', { className: 'mb_pageTitle' }, 'Messaging'),
          h('div', { className: 'mb_hint' }, t('notFound'))))

      const platform = draft.platform || 'line'
      const fields = platformFields(t)[platform] || []
      // Guidance follows the transport: Discord needs no public URL at all, Messenger
      // additionally has Meta's 24-hour reply window, Telegram in long-poll mode needs
      // neither note at all.
      const notes = platform === 'discord'
        ? ['discordNote', 'discordWarn']
        : platform === 'messenger'
          ? ['webhookNote', 'messengerNote', 'windowNote']
          : platform === 'telegram'
            ? []
            : ['webhookNote']

      return h('div', { className: 'mb_wrap' },
        // Header: plugin name on the left, language menu top-right. Picking a
        // language writes it straight away (the bridge reads replyLanguage live).
        h('div', { className: 'mb_card' },
          h('div', { className: 'mb_head' },
            h('div', null,
              h('div', { className: 'mb_pageTitle' }, 'Messaging bridge'),
              h('div', { className: 'mb_cardDesc' }, t('bridgeDesc'))),
            h('div', { className: 'mb_lang' },
              h('label', { className: 'mb_label' }, t('langLabel')),
              h(Select, { value: langCode, options: LANGS, onChange: (v) => edit(['replyLanguage'], v, true) }),
              h('div', { className: state.saved ? 'mb_langSaved' : offEngine ? 'mb_langWarn' : 'mb_hint' },
                state.saved ? t('langSaved') : offEngine ? t('langOff') : t('langHint'))))),

        h('div', { className: 'mb_card' },
          h('div', { className: 'mb_cardTitle' }, t('general')),
          h(Toggle, { label: t('enabledLabel'), checked: draft.enabled, onChange: (v) => edit(['enabled'], v, true) }),
          h('div', { className: 'mb_row' },
            h(Field, { label: t('platformLabel') }, h(Select, { value: platform, options: PLATFORMS, onChange: (v) => edit(['platform'], v) })),
            h(Field, { label: t('engineLabel') }, h(Select, { value: draft.translateBackend || 'google', options: backends(t), onChange: (v) => edit(['translateBackend'], v) })))),

        h('div', { className: 'mb_card' },
          h('div', { className: 'mb_cardTitle' }, t('chanSettings', { n: (PLATFORMS.find((p) => p.code === platform) || {}).label || platform })),
          notes.map((id) => h('div', { key: id, className: id === 'discordWarn' ? 'mb_langWarn' : 'mb_hint' }, t(id))),
          fields.map((f) => h(TextField, { key: f.path.join('.'), field: f, value: getPath(draft, f.path), onEdit: edit, configured: state.configured, t }))),

        h('div', { className: 'mb_card' },
          h('div', { className: 'mb_cardTitle' }, t('advanced')),
          h('div', { className: 'mb_row' },
            h(TextField, { field: { path: ['maxCharsPerMessage'], label: t('maxChars'), num: true }, value: draft.maxCharsPerMessage, onEdit: edit, t }),
            h(TextField, { field: { path: ['maxChunksPerReply'], label: t('maxChunks'), num: true }, value: draft.maxChunksPerReply, onEdit: edit, t })),
          h(TextField, { field: { path: ['publicBaseUrl'], label: t('publicUrl'), placeholder: t('publicUrlPh') }, value: draft.publicBaseUrl, onEdit: edit, t }),
          h('div', { className: 'mb_row' },
            h(Toggle, { label: t('counterLabel'), checked: draft.counterEnabled, onChange: (v) => edit(['counterEnabled'], v) }),
            h(Toggle, { label: t('statsLabel'), checked: draft.showStatsFooter, onChange: (v) => edit(['showStatsFooter'], v) }),
            h(Toggle, { label: t('loadingLabel'), checked: draft.loadingIndicator, onChange: (v) => edit(['loadingIndicator'], v) }))),

        h('div', { className: 'mb_card' },
          h('div', { className: 'mb_cardTitle' }, t('bcTitle')),
          h('div', { className: 'mb_cardDesc' }, t('bcDesc')),
          h(Toggle, { label: t('bcEnabled'), checked: draft.broadcast?.enabled, onChange: (v) => edit(['broadcast', 'enabled'], v, true) }),
          ...(draft.broadcast?.enabled ? [
            h(CheckGroup, {
              key: 'bc-targets',
              label: t('bcTargets'),
              options: PLATFORMS,
              values: draft.broadcast?.platforms || [],
              onToggle: (code) => { const cur = new Set(draft.broadcast?.platforms || []); if (cur.has(code)) cur.delete(code); else cur.add(code); edit(['broadcast', 'platforms'], [...cur]) },
              hint: t('bcTargetsHint'),
            }),
            h(Toggle, { key: 'bc-share', label: t('bcShare'), checked: draft.broadcast?.shareSession, onChange: (v) => edit(['broadcast', 'shareSession'], v), hint: t('bcShareHint') }),
          ] : [])),

        h('div', { className: 'mb_footer' },
          h('button', { className: 'mb_btn', disabled: state.saving || state.writable === false, onClick: () => void save() }, state.saving ? t('saving') : t('save')),
          h('button', { className: 'mb_btn mb_btnGhost', onClick: () => void load() }, t('reload')),
          state.saved ? h('span', { className: 'mb_saved' }, t('savedOk')) : null,
          state.error ? h('span', { className: 'mb_err' }, t('saveFailed') + ': ' + state.error) : null),
        h('div', { className: 'mb_hint' }, t('footerHint')))
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
    // ignored. Exposes the pure form helpers so the write path can be unit-tested,
    // plus the language table so every string is proven to exist in all languages.
    exports.__internals = {
      diffOps, isSecretPath, setPath, getPath, PLATFORM_FIELDS, platformFields,
      LANGS, PLATFORMS, STR, makeT, langIdx, Section,
    }
    return module.exports
  },
})
