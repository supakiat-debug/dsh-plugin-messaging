# dsh-plugin-messaging

Multi-platform **messaging bridge** for [DeepSeek Harness](https://localhost:3080) (DSH).
Talk to your ordinary dsh sessions from **LINE / Telegram / WhatsApp**, with a
**Settings → Messaging** page, per-platform config, **reply-language translation**
(English default / 中文 / ไทย), a **monthly message counter**, and a live
**AI working-status** (elapsed time · tokens/s).

Modelled on the official `dsh-plugin-discord` bridge and the `dsh-qwen-mm-plugins`
settings page. Pure ESM JavaScript — **no build step** for either the backend or the
web client.

---

## Features

| Feature | How |
|---|---|
| Reply in a chosen language | `replyLanguage` = `en` (default) / `zh` / `th`, picked in the **top-right corner** of `Settings → Messaging` — the choice is written the moment you select it and applies to the next answer, no Save button, no restart (a chat that once used `/lang` keeps its own override). **Only the bridge's own messages** (status, errors, "no answer", max-token/length notices, command replies, truncation suffix) are translated — **the AI's answer is always sent verbatim**. On-disk cache (`เก็บไว้`), free Google endpoint, no key. `/lang en\|zh\|th` overrides per chat. |
| Chunk long replies | `maxCharsPerMessage` budget, `maxChunksPerReply` cap (default 3), platform hard limit (LINE 5000 · Telegram/WhatsApp 4096). Prefers paragraph → line → space boundaries. |
| Monthly counter | `/count` — inbound / outbound / real messages / push (metered) / reply (free) / translated, per `YYYY-MM`, auto-rolls over. Doubles as a LINE cost meter (push is metered). |
| AI working-status | On edit-capable platforms (Telegram `editMessageText`, LINE loading) the status message updates with `🤖 Thinking… Ns` (translated), then is replaced by the answer. Footer shows `⏱ Ns · M t/s`. |
| Commands | `/new /current /stop /lang /count /status /sessions /use /quota /access /tools /help` |
| Chat-side permission switch | `/access read\|write\|full` (aliases `/perm`, bare `/access` = status) maps onto the host's permission presets `read-only` / `workspace-write` / `danger-full-access` and switches them for **this chat's session** through `permissionPresets` + `approval.setPolicy` — the same path as the built-in `/permission` command, so the composer picker and the running agent update at once. The AI can also *ask*: a scoped `request_access` tool pushes a message into the chat ("reply `/access write` to grant"), and **nothing changes until the user types it**. `accessCommands` / `aiAccessRequest` toggles. |
| MCP on/off from chat | `/tools` lists every MCP server the **dsh-mcp-manager-plus** page shows; `/tools <name> on\|off` (also `เปิด`/`ปิด`) toggles one through that plugin's loopback API (`GET /servers`, `POST /toggle`), so the patch file keeps a single writer and its live reload does the rest. Names match exactly, then by unique substring; built-in providers are refused. `mcpCommands` toggle. |
| Keep a channel listening | Every platform card leads with a **Keep the connection open** checkbox (`line.keepOpen` / `telegram.keepOpen` / `wa.keepOpen`, default off). Ticked, that channel keeps its webhook route registered / its Telegram long-poll running **even when another platform is selected**, so it stays reachable and answers messages arriving there; un-ticking disposes the route / ends the poll. Both directions apply on save, live — the bridge reconciles its connections on `loader/volatile-update`, so nothing has to restart. |
| Settings UI | `Settings → Messaging`: plugin title on the left with the reply-language menu top-right, platform picker, translate backend, per-platform token/group/webhook fields, chunking + counter toggles. Writes the plugin Config through the host `settings` RPC. Every editable leaf is `.volatile()`, so a save is committed into the *running* plugin (`loader/volatile-update`) instead of remounting it — the bridge reads its config through those live refs. Live: language, keep-open boxes, `enabled` (off closes every connection), chunk budgets, footer/broadcast toggles. Needs a restart: tokens, allowlists, `receiveMode`, webhook paths, `translateBackend` (adapters read them when they start). |

---

## Install

The plugin lives in this workspace at `dsh-plugin-messaging/`. To load it into the
**web** profile it must be resolvable from the profile's `node_modules`, and its
`cordis.patch.yml` row must be composed into the profile's `cordis.yml`.

**Option A — copy into the profile (simplest):**

```powershell
# from C:\Users\Supk\dsh
Copy-Item -Recurse -Force .\dsh-plugin-messaging `
  "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-plugin-messaging"
```

**Option B — npm link / file install:**

```powershell
cd "$env:USERPROFILE\.dsh\profiles\web"
npm install "C:\Users\Supk\dsh\dsh-plugin-messaging"
```

Then make sure the plugin is enabled in the composed `cordis.yml`
(`C:\Users\Supk\.dsh\profiles\web\cordis.yml`). The package ships
`dsh.bundle.patch → cordis.patch.yml` which inserts:

```yaml
- insert:
    - id: messaging-bridge
      name: dsh-plugin-messaging
```

If your profile does not auto-apply installed-plugin patches, add that entry to
`cordis.yml` yourself.

> ⚠️ **Restart required.** The plugin (and its Settings page) only appears after the
> profile restarts. This GUI session runs on that profile, so a restart interrupts
> the current session — do it deliberately.

---

## Configure

Three equivalent ways (pick one):

1. **Settings → Messaging** (after install + restart) — the friendly form.
   Pick platform, reply language, translate backend, fill the platform's token /
   group IDs / webhook path, toggle chunking & counter, **Save**.
2. **Plugins config editor** (generic) — edit the raw `messaging-bridge` config.
3. **`settings.yaml`** — set the `messaging-bridge` namespace directly.

### Secrets

Tokens can live in config **or** in environment variables. Every secret field has a
sibling `*Env` name (default shown) so you can keep secrets out of `settings.yaml`:

| Platform | Secret | Default env var |
|---|---|---|
| LINE | `line.channelAccessToken` | `LINE_CHANNEL_ACCESS_TOKEN` |
| LINE | `line.channelSecret` | `LINE_CHANNEL_SECRET` |
| Telegram | `telegram.botToken` | `TELEGRAM_BOT_TOKEN` |
| WhatsApp | `wa.accessToken` | `WHATSAPP_ACCESS_TOKEN` |
| WhatsApp | `wa.appSecret` | `WHATSAPP_APP_SECRET` |

### Minimal examples

**Telegram (recommended first — long-poll, no public URL, free, editable status):**

```yaml
messaging-bridge:
  enabled: true
  platform: telegram
  replyLanguage: th
  telegram:
    botToken: "123456:ABC..."   # or set TELEGRAM_BOT_TOKEN
    allowedUserIds: ["your-telegram-id"]
```

**LINE (needs a public HTTPS webhook):**

```yaml
messaging-bridge:
  enabled: true
  platform: line
  replyLanguage: th
  publicBaseUrl: "https://your-tunnel.example.com"
  line:
    channelAccessToken: "..."   # or LINE_CHANNEL_ACCESS_TOKEN
    channelSecret: "..."        # or LINE_CHANNEL_SECRET
    allowedGroupIds: ["C..."]   # LINE group id (with leading C)
```

Point the LINE Developers webhook at `https://your-tunnel.example.com/plugins/messaging/line/webhook`.

**Keep more than one channel reachable at the same time** (the checkbox at the top of
each platform card, applied live when you tick it):

```yaml
messaging-bridge:
  platform: line          # the channel the AI "belongs" to by default
  telegram:
    keepOpen: true        # Telegram keeps long-polling and answers too
  wa:
    keepOpen: true        # WhatsApp webhook route stays registered
```

**WhatsApp (webhook-only, public HTTPS + Meta Graph API):**

```yaml
messaging-bridge:
  enabled: true
  platform: whatsapp
  publicBaseUrl: "https://your-tunnel.example.com"
  wa:
    accessToken: "..."          # WHATSAPP_ACCESS_TOKEN
    phoneNumberId: "123..."
    appSecret: "..."            # WHATSAPP_APP_SECRET (X-Hub-Signature-256)
    verifyToken: "my-verify"
```

---

## Platform notes

- **Telegram** — long-poll `getUpdates` by default (NAT-friendly, no public URL).
  `editMessageText` gives the live `t/s` status. Free. **Start here.**
- **LINE** — DSH binds `127.0.0.1` with no TLS, so LINE's HTTPS webhook needs a
  **tunnel / reverse proxy** + `publicBaseUrl`. Reply-by-token is free but single-use
  (~60s); AI turns usually exceed that, so most replies fall back to **metered push**
  — the counter is your cost tool. Loading animation works for 1:1 only.
- **WhatsApp** — webhook-only public HTTPS, GET `hub.verify_token` handshake,
  `X-Hub-Signature-256` HMAC, Graph API `graph.facebook.com/v21.0/{phoneId}/messages`,
  24h rolling window (approved template outside it). No message edit.
- **Discord** — served by the separate `dsh-plugin-discord`; this bridge does not
  duplicate it (the picker lists it for reference).

**Recommended build/rollout order: Telegram → LINE → WhatsApp.**

---

## How the reply-language feature works

**Scope: only the bridge's own messages are translated — never the AI's answer.**
The AI's reply is sent exactly as the model produced it (so code, names, and
technical content are never mangled). What gets translated into `replyLanguage` is
the bridge's boilerplate: the `🤖 Thinking…` status, `⚠️ error`, `(no answer)`,
max-token / length notices, the truncation suffix, and every command reply
(`/help`, `/count`, `/status`, …).

1. The agent finishes a turn; the bridge folds the final assistant text from the
   session events (same fold as the Discord bridge). **This text is sent verbatim.**
2. Only when the bridge must speak for itself (no answer / error / a command) does
   it call `sysText(key, replyLanguage)` / `labels(...)` (`lib/messages.js`).
   `en` short-circuits (no network). `zh → zh-CN`, `th` map to the Google endpoint.
   Dynamic reports (`/count`, `/status`) translate only their static **labels** and
   assemble numbers/ids in code, so the cache stays warm.
3. Results are cached on disk (`messaging-translate-cache.json`, keyed by
   `sha1(target\0text)`); each fixed phrase is fetched at most once per language.
   Network/parse errors pass the English base through (never blocks a reply).
   `translateBackend: off` disables translation entirely.
4. A footer (`⏱ Ns · M t/s`) is appended, then the text is chunked and sent.

---

## Development

```powershell
cd C:\Users\Supk\dsh
node ./dsh-plugin-messaging/test/smoke.mjs   # 21 dependency-free tests
```

Covers chunking, translation (fake fetch + cache + passthrough), commands, state,
counter (incl. month roll), reply folding (real event shape), config resolution,
the full module graph import, and the client bundle's module contract.

### Layout

```
lib/index.js            cordis service (name/inject/Config/apply)
lib/config.js           schemastery Config + resolveConfig (deep defaults)
lib/bridge.js           transport-agnostic orchestration (agent/session/turn/translate/chunk)
lib/chunk.js            reply chunking + platform hard limits
lib/translate.js        Google translate + disk cache + passthrough
lib/commands.js         slash-command parser + help
lib/state.js            per-chat binding store (JSON, atomic)
lib/counter.js          monthly counter (JSON, atomic, auto-roll)
lib/reply.js            fold session events -> reply text
lib/adapters/*.js       telegram / line / whatsapp transports
lib/client.js           Settings > Messaging web bundle (no build step)
cordis.patch.yml        profile patch row
test/smoke.mjs          smoke tests
```

---

## Status / limitations

- Backend + client are complete and unit-tested. The agent/session calls mirror
  `dsh-plugin-discord` (`agents.create` / `agents.resume({resumeSessionId})` /
  `followup` / `whenIdle` / `snapshotEvents`) and should be smoke-tested against a
  live host once installed.
- Injected capability notice uses the producer-owned source kind
  `plugin:dsh-plugin-messaging` (required by message format v4).
- Secrets entered in the Settings page persist to `settings.yaml`; use the `*Env`
  fields to keep them in the environment instead.
