# InkChat

InkChat is a real-time chat application built for e-ink devices, primarily the Kindle browser. It runs entirely on Cloudflare's infrastructure with no traditional server. Users can register an account, chat in a general room, and create or browse topic-specific channels. All messages are moderated automatically by OpenAI before they are stored.

Live: https://chat.kindlemodshelf.me

---

## How it works

The application is split into two Cloudflare Workers that talk to each other and to an Upstash Redis database.

The first Worker (`inkchat`) serves the frontend files. The second Worker (`slatechat-proxy`) handles every API call, WebSocket connection, and database operation. The frontend never touches Redis directly — it only talks to the proxy Worker over HTTPS.

When a user loads the page, they get a single HTML document with two JavaScript files loaded. Those files handle all authentication, message polling, topic navigation, and WebSocket upgrades entirely in the browser without any page reloads.

---

## File reference

### `worker.js`

The frontend gate Worker. It runs at the edge on every request to `chat.kindlemodshelf.me`.

Requests to `/` return the full application HTML inline from this file. Every other request (CSS, JS, admin panel) is forwarded to the static assets binding, which serves the contents of the `frontend/` folder.

The HTML served from this file includes all of the application structure: the login form, the main chat shell, the topic browser, the inbox, settings, terms of use, and the topic creation modal. The actual behaviour of those elements lives in `app.js`.

### `wrangler.jsonc`

Cloudflare Wrangler configuration for the frontend Worker. Declares the Worker name (`inkchat`), entry point (`worker.js`), the `frontend/` folder as the static assets directory, and the route that maps `chat.kindlemodshelf.me/*` to this Worker.

---

### `backend/index.js`

The main API Worker. This is where all application logic lives. It handles:

- **Authentication** — registration, login, logout, session resolution, and password changes. Passwords are hashed with PBKDF2 (100,000 iterations) with a per-deployment pepper. Sessions are random UUIDs stored in Redis with a 30-day TTL.
- **Message sending** — validates the session, checks for bans and mutes, enforces a per-IP cooldown (1 message per IP, randomised 1-3 second window), runs the message through OpenAI moderation, then stores it in Redis and broadcasts a WebSocket notification.
- **Topics** — users can create named topic channels (1 per day, moderated), browse and search them, and send messages within them. Topic messages follow the same moderation and rate-limit rules as general chat.
- **IP geolocation** — on every registration and login, the client IP is looked up against the ip-api.com free API. The result (city, region, country, ISP, proxy and hosting flags) is cached in Redis for 90 days and stored with the sign-in record.
- **VPN and proxy blocking** — registration is blocked if the IP is detected as a proxy or hosting provider, either by Cloudflare's AS organisation data or by the ip-api.com `proxy`/`hosting` fields.
- **Admin API** — a separate set of endpoints protected by an admin session token. Allows user lookup, account/device/IP bans, mutes, password resets, session revocation, message deletion, topic deletion, and viewing the strikes leaderboard, blocked message log, and sign-in log.
- **Strike system** — when a user's message or topic name is blocked by moderation, a strike is recorded against their account and added to a Redis sorted set used for the leaderboard.

All Redis access goes through a single `redis()` helper function that talks to Upstash over HTTPS. It supports both single commands and pipelined batches in one call.

### `backend/chat-room.js`

A Cloudflare Durable Object. Its only job is to hold open WebSocket connections and fan out notifications.

When a client connects, it upgrades to a WebSocket through this object. When the API Worker stores a new message, it sends a POST to this Durable Object with a small JSON payload (`{type:'notify'}` for general chat, `{type:'topic_notify',id}` for a specific topic). The Durable Object forwards that payload to every connected WebSocket. Clients that receive the notification then fetch new messages from the API. The Durable Object does not store any messages itself.

### `backend/wrangler.toml`

Wrangler configuration for the API Worker. Declares the Worker name (`slatechat-proxy`), entry point (`index.js`), the `ChatRoom` Durable Object binding, and the SQLite migration for the Durable Object's storage. All secrets (Redis URL and token, OpenAI key, admin password, password salt) are set separately with `wrangler secret put` and are not in this file.

### `backend/.dev.vars`

Local development secrets file. Contains the `PASSWORD_SALT` and `ADMIN_PASSWORD` values used when running the Worker locally with `wrangler dev`. This file is not deployed and should not be committed to version control.

### `backend/test-suite.js`

A test script for the backend API. Covers registration, login, session validation, messaging, moderation, and admin operations. Run directly with Node or `wrangler dev` in local mode.

---

### `frontend/app.js`

The main client-side application. Written in ES5 so it runs on the Kindle's older browser engine without transpilation.

Manages all application state in a single `S` object: the current user session, which view is active (general chat, topic list, or a specific topic), the reply-to context, the WebSocket connection, and the polling timer.

On load it checks for an existing session, then either shows the login screen or boots into the chat. It opens a WebSocket to the API Worker and listens for notification payloads. On receiving a notification it fetches new messages and re-renders only the entries it has not seen before (tracked by timestamp). When the WebSocket drops it falls back to polling every few seconds.

The send flow locks the UI optimistically, calls the appropriate API endpoint, and unlocks on response. Replies, emoji picker, inbox (mentions and replies), settings, and topic creation are all handled in this file.

### `frontend/telemetry.js`

Device identity and HTTP client layer. Also written in ES5.

On load it generates or retrieves a persistent device ID stored in both `localStorage` and a cookie. It also computes a hardware fingerprint from screen dimensions, pixel ratio, platform, language, timezone, CPU count, memory, canvas rendering output, and WebGL renderer info — hashed with FNV-1a into a short hex string.

Exposes `window.InkAPI`, which provides named methods for every backend endpoint: `login`, `register`, `sendMessage`, `getMessages`, `getSession`, `logout`, `changePassword`, `getTopics`, `createTopic`, `getTopicMessages`, and `sendTopicMessage`. All methods use `XMLHttpRequest` with `withCredentials: true` so session cookies are included automatically.

### `frontend/style.css`

All styles for the user-facing application. Targets the Kindle's monochrome e-ink display: no gradients, no shadows, high-contrast borders, a system monospace font stack, and layout that fits narrow screens. Also includes styles for all modals, the topic browser, the emoji picker, and the status bar.

### `frontend/admin.html`

A self-contained admin panel. Served as a static file but blocked from Kindle and mobile user agents by the API Worker.

After authenticating with the admin password, the dashboard shows four panels: a user lookup tool on the left, a centre column with tabs for live chat, topic management, blocked message log, and sign-in log, and a right column with a quick-ban tool, the strikes leaderboard, and an activity log.

All admin API calls include the `X-Admin-Token` header. The panel polls the chat feed every four seconds and renders messages with inline delete and mute buttons.

### `frontend/tos.html`

Static terms of use page. Linked from the registration form.

---

### `docs/redis-schema-guide.md`

An early reference document for the Redis schema written before the current design was settled. It describes an older device-binding model that is no longer in use. Kept for historical reference only.

---

## Redis key layout

| Key pattern | Type | Contents |
|---|---|---|
| `user:{username}` | Hash | `password_hash`, `linked_ips`, `strikes` |
| `session:{token}` | String | Username, expires in 30 days |
| `sessions:user:{username}` | Set | All active session tokens for a user |
| `session:admin:{token}` | String | `"1"`, expires in 2 hours |
| `sessions:admin` | Set | All active admin session tokens |
| `account:status:{username}` | String | `"BANNED"` if banned |
| `device:status:{id}` | String | `"BANNED"` if device-banned |
| `ip:{address}` | String | `"BANNED"` if IP-banned |
| `mute:{username}` | String | `"1"` with TTL, expires when mute ends |
| `chat:messages` | List | Last 100 general chat messages as JSON strings |
| `topics` | Sorted Set | Topic IDs scored by creation time |
| `topic:{id}` | Hash | `name`, `creator`, `created_at`, `msg_count` |
| `topic:{id}:messages` | List | Last 100 messages in that topic |
| `topic:daily:{username}` | String | Set for 24 hours after creating a topic |
| `strikes:leaderboard` | Sorted Set | Usernames scored by strike count |
| `blocked:messages` | List | Last 500 moderation-blocked attempts as JSON |
| `signin:log` | List | Last 500 sign-in records as JSON |
| `ip_geo:{address}` | String | Cached ip-api.com response, expires in 90 days |
| `rate:register:{ip}` | String | Registration attempt count, expires in 1 hour |
| `rate:login:{ip}` | String | Login attempt count, expires in 5 minutes |
| `rate:send:{token}` | String | Message count, expires in 5 seconds |
| `cooldown:ip:{address}` | String | Per-IP send lock, expires in 1-3 seconds randomly |
| `surge:register` | String | Global registration count, expires in 60 seconds |

---

## Deployment

Two separate Workers must be deployed. Both use Wrangler.

```
# API Worker
npx wrangler deploy --config backend/wrangler.toml

# Frontend Worker
npx wrangler deploy --config wrangler.jsonc
```

Secrets are set once with `wrangler secret put` and are never stored in config files:

```
wrangler secret put UPSTASH_REDIS_REST_URL   --config backend/wrangler.toml
wrangler secret put UPSTASH_REDIS_REST_TOKEN --config backend/wrangler.toml
wrangler secret put OPENAI_API_KEY           --config backend/wrangler.toml
wrangler secret put PASSWORD_SALT            --config backend/wrangler.toml
wrangler secret put ADMIN_PASSWORD           --config backend/wrangler.toml
```
