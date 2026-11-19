# dsh-plugin-messaging

Multi-platform **messaging bridge** for [DeepSeek Harness](http://127.0.0.1:3080) (DSH).
Talk to your ordinary dsh sessions from **LINE · Telegram · WhatsApp · Discord ·
Facebook Messenger**, through a **Settings → Messaging** page, with per-platform
config, **broadcast** to every connected chat, **reply-language translation** (English
default / 中文 / ไทย), a **monthly message counter**, and a live
**AI working-status** (elapsed time · tokens/s).

Modelled on the official `dsh-plugin-discord` bridge and the `dsh-qwen-mm-plugins`
settings page. Pure ESM JavaScript — **no build step** for either the backend or the
web client.

---

## Features

| Feature | How |
|---|---|
| Five transports | `platform: line \| telegram \| whatsapp \| discord \| messenger`. One channel is primary; any number of the others can stay listening at the same time (see *Keep a channel listening*), and **Broadcast** copies answers to all of them. |
| Reply in a chosen language | `replyLanguage` = `en` (default) / `zh` / `th`, picked in the **top-right corner** of `Settings → Messaging` — the choice is written the moment you select it (no Save button, no restart) and the next bridge message already uses it (a chat that once used `/lang` keeps its own override). **Only the bridge's own messages** (status, errors, "no answer", max-token/length notices, command replies, truncation suffix) are translated — **the AI's answer is always sent verbatim**. With `translateBackend: off` even those phrases stay as authored. On-disk cache, free Google endpoint, no key. `/lang en\|zh\|th` overrides per chat. |
| Broadcast messages | Copy every AI answer to the other channels too, or fold all channels into **one shared session** with a `[MSG-TG]`-style origin prefix. See [Broadcast messaging](#broadcast-messaging). |
| Chunk long replies | `maxCharsPerMessage` budget, `maxChunksPerReply` cap (default 3), platform hard limit (LINE 5000 · Telegram/WhatsApp 4096 · **Discord/Messenger 2000**). Prefers paragraph → line → space boundaries. |
| Monthly counter | `/count` — inbound / outbound / real messages / push (metered) / reply (free) / translated, per `YYYY-MM`, auto-rolls over. Doubles as a LINE cost meter (push is metered). |
| AI working-status | Where the platform can edit a message (Telegram `editMessageText`, **Discord `PATCH …/messages/{id}`**) the status message updates with `🤖 Thinking… Ns` (translated), then is replaced by the answer. LINE uses its loading animation (1:1 only). WhatsApp/Messenger can only send a typing bubble. Footer shows `⏱ Ns · M t/s`. |
| Commands | `/new /current /stop /lang /count /status /sessions /use /quota /access /tools /help` |
| Chat-side permission switch | `/access read\|write\|full` (aliases `/perm`, bare `/access` = status) maps onto the host's permission presets `read-only` / `workspace-write` / `danger-full-access` and switches them for **this chat's session** through `permissionPresets` + `approval.setPolicy` — the same path as the built-in `/permission` command, so the composer picker and the running agent update at once. The AI can also *ask*: a scoped `request_access` tool pushes a message into the chat ("reply `/access write` to grant"), and **nothing changes until the user types it**. `accessCommands` / `aiAccessRequest` toggles. |
| MCP on/off from chat | `/tools` lists every MCP server the **dsh-mcp-manager-plus** page shows; `/tools <name> on\|off` (also `เปิด`/`ปิด`) toggles one through that plugin's loopback API (`GET /servers`, `POST /toggle`), so the patch file keeps a single writer and its live reload does the rest. Names match exactly, then by unique substring; built-in providers are refused. `mcpCommands` toggle. |
| Keep a channel listening | Every platform card leads with a **Keep the connection open** checkbox (`line.keepOpen` / `telegram.keepOpen` / `wa.keepOpen` / `discord.keepOpen` / `messenger.keepOpen`, default off). Ticked, that channel keeps its webhook route registered / its Telegram long-poll or Discord gateway running **even when another platform is selected**, so it stays reachable and answers messages arriving there; un-ticking disposes the route / ends the poll / closes the socket. Both directions apply on save, live — the bridge reconciles its connections on `loader/volatile-update`, so nothing has to restart. |
| Settings UI | `Settings → Messaging`: plugin title on the left with the language menu top-right, platform picker (five platforms), translate backend, per-platform token/group/webhook fields, chunking + counter toggles. **The page itself is drawn from `replyLanguage`** — every label, hint and button comes from one `th / en / zh` string table, so picking a language repaints the whole page immediately (the picker always lists each language in its own script). Writes the plugin Config through the host `settings` RPC. Every editable leaf is `.volatile()`, so a save is committed into the *running* plugin (`loader/volatile-update`) instead of remounting it — the bridge reads its config through those live refs. Live: language, keep-open boxes, `enabled` (off closes every connection), chunk budgets, footer/broadcast toggles. Needs a restart: tokens, allowlists, `receiveMode`, webhook paths, `translateBackend` (adapters read them when they start). |

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
> the current session — do it deliberately. A restart is also what picks up changes
> to `lib/client.js`, because the running host snapshots the settings bundle at boot.

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
| LINE | `line.channelSecret` **(signing — required)** | `LINE_CHANNEL_SECRET` |
| Telegram | `telegram.botToken` | `TELEGRAM_BOT_TOKEN` |
| WhatsApp | `wa.accessToken` | `WHATSAPP_ACCESS_TOKEN` |
| WhatsApp | `wa.appSecret` **(signing — required)** | `WHATSAPP_APP_SECRET` |
| Discord | `discord.botToken` | `DISCORD_BOT_TOKEN` |
| Messenger | `messenger.pageAccessToken` | `MESSENGER_PAGE_ACCESS_TOKEN` |
| Messenger | `messenger.appSecret` **(signing — required)** | `MESSENGER_APP_SECRET` |

Secret fields are marked `role('secret')` in the schema, so a remote `describe()`
redacts them; the Settings page renders them as password boxes, and **a blank field
never overwrites a stored token** — only a changed value is written.

**The three signing secrets are not optional.** A webhook body states who sent it —
that PSID / userId / waId *is* the bridge's allowlist — so the signature is the only
thing separating "LINE sent this" from "someone found the URL". There is no
"no secret = dev mode" any more: `start()` refuses to register the route at all
without one, and the log says so (and what to fill in) instead of leaving a
login-as-anyone endpoint quietly verified in the platform's dashboard. Telegram and
Discord are unaffected — they dial out, so nothing is listening.

Where to get them: LINE Developers → your channel → Messaging API → **Channel
secret**; Meta App Dashboard → **Settings → Basic → App Secret** (same secret for
Messenger and WhatsApp).

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

**Discord (outbound WebSocket — no public URL, no tunnel, editable status):**

```yaml
messaging-bridge:
  enabled: true
  platform: discord
  discord:
    botToken: "MTI3..."        # or DISCORD_BOT_TOKEN
    allowedUserIds: ["123456789012345678"]   # Discord user id (Developer mode → Copy ID)
    allowedGuildIds: []        # empty = any server the bot is in
    allowedChannelIds: []      # empty = any channel it can see
    requireMentionInGuild: true  # in servers, answer only when @mentioned
    messageContentIntent: true   # you must also flip the switch in the Developer Portal
    editLiveStatus: true         # "🤖 Thinking… Ns" edited in place, then replaced
```

**Facebook Messenger (webhook + Graph API, needs public HTTPS):**

```yaml
messaging-bridge:
  enabled: true
  platform: messenger
  publicBaseUrl: "https://your-tunnel.example.com"
  messenger:
    pageAccessToken: "EAAG..."   # MESSENGER_PAGE_ACCESS_TOKEN
    appSecret: "abc..."          # MESSENGER_APP_SECRET  (X-Hub-Signature-256)
    verifyToken: "my-verify"     # you choose it, then type the same value in Meta
    pageId: "123456789"          # optional; blank sends via /me
    allowedUserIds: []           # PSIDs; empty = anyone the Page can reply to
    graphVersion: "v24.0"        # Meta rolls versions on a schedule
    outOfWindowTag: ""           # e.g. HUMAN_AGENT to reply past 24 h (see below)
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

**Keep more than one channel reachable at the same time** (the checkbox at the top of
each platform card, applied live when you tick it):

```yaml
messaging-bridge:
  platform: line            # the channel the AI "belongs" to by default
  telegram:
    keepOpen: true          # Telegram keeps long-polling and answers too
  discord:
    keepOpen: true          # Discord keeps its gateway socket open
  wa:
    keepOpen: true          # WhatsApp webhook route stays registered
```

---

## Platform notes

- **Telegram** — long-poll `getUpdates` by default (NAT-friendly, no public URL).
  `editMessageText` gives the live `t/s` status. Free. **Start here.**
- **Discord** — **the reason this bridge needs no public URL for a second channel.**
  The plugin opens an *outbound* WebSocket to the Discord Gateway (v10), so it works
  behind NAT with no tunnel, no TLS termination and no port forwarding — the same
  trick the official `dsh-plugin-discord` uses, ported faithfully: `HELLO` →
  heartbeat with jittered first beat and zombie detection (close 4901) → `Identify`,
  `Resume` with the last `seq` after a drop, `Invalid Session` re-identify, exponential
  backoff capped at 60 s, and **automatic downgrade on close 4014** (drops the
  `MESSAGE_CONTENT` intent instead of reconnecting forever). Outbound REST sends the
  bot `User-Agent` Discord requires and honours `retry_after` on 429. Replies
  **thread under the message that asked** (`message_reference`), never ping anybody
  (`allowed_mentions.parse: []`), and the status message is edited in place.
  In servers the bot answers only when @mentioned (`requireMentionInGuild`), DMs are
  mention-free. Own messages and other bots are ignored, so it cannot loop itself.
  > ⚠️ If you also run `dsh-plugin-discord`, do **not** point both at the same bot
  > token — Discord allows multiple gateway connections per bot and the user would get
  > two answers. Keep one plugin per token.
- **Facebook Messenger** — the Meta Graph API (`graph.facebook.com/<version>/{page}/messages`).
  Inbound is a webhook: `GET` handshake on `hub.verify_token` (the plugin echoes
  `hub.challenge`), `POST` verified with `X-Hub-Signature-256` (HMAC-SHA256 of the raw
  body with your App Secret, constant-time compare) and **acked with 200 before the AI
  turn starts**, because Meta retries anything slower than 20 s; `mid` de-duplicates
  those retries. So you **do** need a public HTTPS URL here (`publicBaseUrl` + a
  tunnel), exactly like LINE/WhatsApp. Only text both ways; `is_echo`, empty text,
  attachments and read receipts are skipped. Replies are one-to-one: the Send API
  cannot address Messenger group threads, so a Messenger chat is never a group.
  **The 24-hour rule** — Meta only lets a Page reply within 24 h of the user's last
  message; past that the send fails with error `#10` (subcode `551`). The plugin says
  so plainly, and if you set `outOfWindowTag` (e.g. `HUMAN_AGENT`) it retries once as
  `messaging_type: MESSAGE_TAG`. Use a tag only where Meta's policy allows it.
  PSIDs are app-scoped, so they are not Facebook user ids and won't match other apps.
- **LINE** — DSH binds `127.0.0.1` with no TLS, so LINE's HTTPS webhook needs a
  **tunnel / reverse proxy** + `publicBaseUrl`. Reply-by-token is free but single-use
  (~60s); AI turns usually exceed that, so most replies fall back to **metered push**
  — the counter is your cost tool. Loading animation works for 1:1 only.
- **WhatsApp** — webhook-only public HTTPS, GET `hub.verify_token` handshake,
  `X-Hub-Signature-256` HMAC, Graph API `graph.facebook.com/v21.0/{phoneId}/messages`,
  24h rolling window (approved template outside it). No message edit.

**Recommended build/rollout order: Telegram → Discord → LINE → Messenger → WhatsApp**
(first two need no public URL, the rest do).

Neither Discord nor Messenger supports attachments in this bridge: images, files and
reactions are ignored in both directions, and long text is chunked to that platform's
2000-character limit.

### Config-only keys (no Settings field, on purpose)

| Key | Default | Why it stays in the config file |
|---|---|---|
| `discord.gatewayUrl` | blank → `wss://gateway.discord.gg/?v=10&encoding=json` | Only useful behind a proxy or against a self-hosted shim. |
| `discord.apiBaseUrl` | blank → `https://discord.com/api/v10` | Same; API version pinning lives here. |
| `messenger.webhookPath` | `/plugins/messaging/messenger/webhook` | Changing it means changing Meta's webhook URL too; typed deliberately. |

`messenger.graphVersion` *is* exposed in the Settings page, because Meta retires Graph
versions on a published schedule and you will need to bump it without editing YAML.

---

## Broadcast messaging

One config block, `messaging.broadcast`, does two related jobs. Both are **live** —
toggling them applies on save, no restart.

### 1. One-way copy (`broadcast.enabled` + `broadcast.platforms`)

Every AI answer produced on the channel you are typing into is **copied** to each
ticked platform in `broadcast.platforms`:

```yaml
messaging-bridge:
  platform: telegram          # you type on Telegram
  broadcast:
    enabled: true
    platforms: [discord, messenger]   # the answer is copied there too
```

- The copy goes to each target's **last-known chat** — the chat that platform last
  wrote to (the bridge records it per platform). A target with no recorded chat yet,
  or whose adapter is not running, is skipped silently rather than failing the turn.
- The **origin platform is always excluded**, so your Telegram message never comes
  back at you twice.
- Each copy is prefixed with the **origin tag** — `[MSG-TG]`, `[MSG-Line]`, `[MSG-WA]`,
  `[MSG-DC]`, `[MSG-FB]` — so recipients know where the answer came from, and it is
  chunked against the *target's* hard limit (a 4096-char Telegram answer becomes three
  Discord/Messenger chunks, not one rejected post).
- Copies count as **push** in `/count`, i.e. the metered column on LINE. Broadcasting
  to five channels multiplies what you pay where the platform charges per message.
- Because a copy is a plain send, the target's own rules apply: Messenger needs the
  24-hour window (or `outOfWindowTag`), WhatsApp needs its own window, and Discord
  posts into the **channel it last heard from** — a DM you sent the bot counts, so a
  broadcast can land in your DMs. Addresses of the form `user:<discord user id>` are
  also accepted by the sender, which opens (and caches) that DM channel on demand.

**A target only receives if that adapter is actually running.** Enabling broadcast
brings up all five adapters at once — the ones with no credentials log
`… no token — adapter idle` and stay quiet — which is the whole point: switching
channels needs no restart. If you turn broadcast *off* again, keep the ones you still
want to receive via `keepOpen`.

### 2. One shared session (`broadcast.shareSession`)

Folds **every** running platform into a **single dsh session** instead of one session
per chat, and prefixes each relayed prompt with the channel that typed it:

```
[MSG-DC] what did I ask yesterday?
```

so the model can tell who said what. Session titles become `MSG-<TAG> …`. Turn this on
when you want continuity — ask something on Discord, continue it on Messenger — and
off when you want each chat isolated (the default: `${platform}:${chatId}`).

### In the Settings page

The **Broadcast Messages** card holds both switches plus a *Copy replies to* checkbox
group listing all five platforms. Ticking **Enable broadcast** also starts every
configured adapter, which is the quickest way to go multi-channel from a cold start.

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
node ./dsh-plugin-messaging/test/smoke.mjs   # 53 dependency-free tests
```

Covers chunking (incl. the 2000-char Discord/Messenger limit), translation (fake fetch
+ cache + passthrough), commands, state, counter (incl. month roll), reply folding
(real event shape), config resolution and the live volatile refs, the settings bundle's
module contract and three-language string table, the Telegram allowlist, the
`/access` + `/tools` paths, keep-open reconciliation — and for the transports: the
Discord gateway protocol against a stubbed socket (identify, heartbeat, resume, close
4014 downgrade, fatal close), Discord REST (bot User-Agent, `allowed_mentions`, 429
retry, DM cache), the Discord adapter's mention/bot/allowlist gates and its
start/stop race, Messenger's signature check, webhook handshake, de-duplication and
24-hour-tag retry, `deliver.js` (a refused live-status edit sends the whole reply
instead of losing it; partial sends count only what landed), and the rule that no
webhook adapter registers a route it cannot verify.

### Layout

```
lib/index.js            cordis service (name/inject/Config/apply) + keep-open reconcile
lib/config.js           schemastery Config + resolveConfig (deep defaults) + wantedPlatforms
lib/bridge.js           transport-agnostic orchestration (agent/session/turn/translate/chunk/broadcast)
lib/chunk.js            reply chunking + platform hard limits
lib/translate.js        Google translate + disk cache + passthrough
lib/commands.js         slash-command parser + help
lib/state.js            per-chat binding store (JSON, atomic)
lib/counter.js          monthly counter (JSON, atomic, auto-roll)
lib/reply.js            fold session events -> reply text
lib/deliver.js          the last centimetre: live status -> plain send fallback, honest chunk counts
lib/adapters/telegram.js   long-poll / webhook, Markdown, live status edits
lib/adapters/line.js       push API, reply token, loading animation
lib/adapters/whatsapp.js   Graph API Cloud API transport
lib/adapters/discord.js    gateway v10 client + REST + adapter (mention gate, live status)
lib/adapters/messenger.js  Page webhook (HMAC) + Send API + 24h window fallback
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
- Webhook channels (LINE, WhatsApp, Messenger) stay **shut** until their signing
  secret is set — see [Secrets](#secrets). The log names the field to fill in.
- Delivery is counted, not assumed: a channel reports how many chunks the platform
  accepted, a refused Graph 503 fails the turn instead of reporting success, and a
  live status whose final edit is refused falls back to sending the answer as a new
  message. The monthly counter therefore matches what people actually received.
- Text only on every platform: no attachments, reactions, buttons or carousels.
- Discord needs the **Message Content Intent** switched on in the Developer Portal or
  the gateway closes 4014; the plugin then retries without that intent and logs that
  message text will be empty, rather than failing quietly.
- Messenger and WhatsApp both put you at the mercy of Meta's review process for anything
  beyond your own testing; the 24-hour window is a platform rule, not a plugin bug.
