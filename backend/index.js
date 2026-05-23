/**
 * InkChat — Cloudflare Worker Edge Proxy
 * Production-hardened messaging backend for legacy Kindle e-ink browsers.
 *
 * All secrets (UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, OPENAI_API_KEY,
 * PASSWORD_SALT, ADMIN_PASSWORD) are injected via Cloudflare Worker runtime env
 * bindings and are never transmitted to or accessible by the client.
 */

const ALLOWED_ORIGINS = [
    "https://chat.kindlemodshelf.me",
    "https://inkchat.kindlemodshelf.workers.dev",
    "http://localhost:8000"
];
const USER_SESSION_COOKIE       = "inkchat_session";
const ADMIN_SESSION_COOKIE      = "inkchat_admin_session";
const USER_SESSION_TTL_SECONDS  = 2592000;  // 30 days
const ADMIN_SESSION_TTL_SECONDS = 7200;     // 2 hours
const PBKDF2_ITERATIONS         = 100000;
const PBKDF2_KEY_BYTES          = 32;

export default {
    async fetch(request, env, ctx) {
        const url      = new URL(request.url);
        const pathname = url.pathname;
        const clientIp = (request.cf && request.cf.connectingIp) ? request.cf.connectingIp : "127.0.0.1";
        const ua       = request.headers.get("User-Agent") || "";

        const isAdminPath = pathname === "/admin.html" || pathname.startsWith("/api/admin");
        const isLoopback  = clientIp === "127.0.0.1";

        // Admin panel — desktop workstations only, reject mobile/Kindle UA strings
        if (pathname === "/admin.html") {
            if (/Kindle|Paperwhite|Silk|Android|iPhone|iPad|iPod|Mobile|Phone/i.test(ua)) {
                return new Response("Forbidden: Administrative console is restricted to desktop workstations.", {
                    status: 403,
                    headers: { "Content-Type": "text/plain" }
                });
            }
        }

        const origin = request.headers.get("Origin");
        const isLocalOrigin = origin && (
            origin === "null" ||
            origin.startsWith("http://localhost:") ||
            origin.startsWith("http://127.0.0.1:") ||
            origin === "http://localhost" ||
            origin === "http://127.0.0.1"
        );

        if (origin && !isLocalOrigin && ALLOWED_ORIGINS.indexOf(origin) === -1) {
            return new Response(JSON.stringify({ error: "CORS Policy: Origin unauthorized." }), {
                status: 403,
                headers: { "Content-Type": "application/json" }
            });
        }

        const corsHeaders = {
            "Access-Control-Allow-Origin":      origin || "https://chat.kindlemodshelf.me",
            "Access-Control-Allow-Methods":     "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers":     "Content-Type, Authorization, X-Admin-Token",
            "Access-Control-Allow-Credentials": "true",
            "Access-Control-Max-Age":           "86400",
            "Vary":                             "Origin"
        };

        // IP ban — fail-open to survive Upstash outages
        try {
            const ipStatus = await queryUpstash(["GET", `ip:${clientIp}`], env);
            if (ipStatus === "BANNED") {
                return jsonResponse({ error: "Access Denied: Your network address has been permanently restricted." }, 403, corsHeaders);
            }
        } catch (e) {
            console.error("IP ban check error:", e.message);
        }

        if (request.method === "OPTIONS") {
            return new Response(null, { status: 204, headers: corsHeaders });
        }

        // ── Route dispatch ──────────────────────────────────────────────────

        if (pathname === "/api/moderate-content"    && request.method === "POST") return handleModerateContent(request, env, corsHeaders);
        if (pathname === "/api/get-messages"        && request.method === "GET")  return handleGetMessages(request, env, corsHeaders);
        if (pathname === "/api/send-message"        && request.method === "POST") return handleSendMessage(request, env, corsHeaders, ctx);
        if (pathname === "/api/register"            && request.method === "POST") return handleRegister(request, env, corsHeaders);
        if (pathname === "/api/login"               && request.method === "POST") return handleLogin(request, env, corsHeaders);
        if (pathname === "/api/session"             && request.method === "GET")  return handleSessionInfo(request, env, corsHeaders);
        if (pathname === "/api/logout"              && request.method === "POST") return handleLogout(request, env, corsHeaders);
        if (pathname === "/api/change-password"     && request.method === "POST") return handleChangePassword(request, env, corsHeaders);
        if (pathname === "/api/admin/login"         && request.method === "POST") return handleAdminLogin(request, env, corsHeaders);
        if (pathname === "/api/admin/session"       && request.method === "GET")  return handleAdminSessionInfo(request, env, corsHeaders);
        if (pathname === "/api/admin/user-lookup"   && request.method === "GET")  return handleAdminUserLookup(request, env, corsHeaders);
        if (pathname === "/api/admin/ban"           && request.method === "POST") return handleAdminBan(request, env, corsHeaders);
        if (pathname === "/api/admin/delete-message"&& request.method === "POST") return handleAdminDeleteMessage(request, env, corsHeaders);
        if (pathname === "/api/admin/purge-messages"&& request.method === "POST") return handleAdminPurgeMessages(request, env, corsHeaders);
        if (pathname === "/api/admin/mute-user"     && request.method === "POST") return handleAdminMuteUser(request, env, corsHeaders);
        if (pathname === "/api/admin/reset-password"&& request.method === "POST") return handleAdminResetPassword(request, env, corsHeaders);
        if (pathname === "/api/admin/revoke-sessions"&& request.method === "POST") return handleAdminRevokeSessions(request, env, corsHeaders);

        return jsonResponse({ error: "Route not found." }, 404, corsHeaders);
    }
};

// ════════════════════════════════════════════════════════════
// Redis layer
// ════════════════════════════════════════════════════════════

async function queryUpstash(commandArray, env) {
    const redisUrl   = env.UPSTASH_REDIS_REST_URL;
    const redisToken = env.UPSTASH_REDIS_REST_TOKEN;

    if (!redisUrl || !redisToken) {
        throw new Error("Upstash Redis bindings are missing or unconfigured.");
    }

    let endpoint = redisUrl.replace(/\/$/, "");
    if (Array.isArray(commandArray[0])) {
        endpoint += "/pipeline";
    }

    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), 4000);

    let response;
    try {
        response = await fetch(endpoint, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${redisToken}`,
                "Content-Type":  "application/json"
            },
            body: JSON.stringify(commandArray),
            signal: controller.signal
        });
    } finally {
        clearTimeout(abortTimer);
    }

    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Upstash REST gateway HTTP ${response.status}: ${errText}`);
    }

    const data = await response.json();

    if (data.error) {
        throw new Error(`Upstash database error: ${data.error}`);
    }

    if (Array.isArray(data)) {
        for (let i = 0; i < data.length; i++) {
            if (data[i] && data[i].error) {
                throw new Error(`Pipeline command [${i}] failed: ${data[i].error}`);
            }
        }
        return data;
    }

    return data.result;
}

function flatArrayToObject(arr) {
    if (!arr || !Array.isArray(arr)) return {};
    const obj = {};
    for (let i = 0; i < arr.length; i += 2) {
        if (arr[i]) obj[arr[i]] = arr[i + 1];
    }
    return obj;
}

// ════════════════════════════════════════════════════════════
// Cookie helpers
// ════════════════════════════════════════════════════════════

function parseCookies(request) {
    const raw = request.headers.get("Cookie") || "";
    const out = {};
    raw.split(";").forEach(part => {
        const sep = part.indexOf("=");
        if (sep === -1) return;
        const name  = part.slice(0, sep).trim();
        const value = part.slice(sep + 1).trim();
        if (name) out[name] = decodeURIComponent(value);
    });
    return out;
}

function getCookieValue(request, name) {
    return parseCookies(request)[name] || null;
}

function buildCookie(request, name, value, options = {}) {
    const isHttps = new URL(request.url).protocol === "https:";
    const parts   = [
        `${name}=${encodeURIComponent(value)}`,
        "Path=/",
        `Max-Age=${options.maxAge || 0}`,
        isHttps ? "SameSite=None" : "SameSite=Lax"
    ];
    if (isHttps)                    parts.push("Secure");
    if (options.httpOnly !== false) parts.push("HttpOnly");
    return parts.join("; ");
}

function clearCookie(request, name, options = {}) {
    const isHttps = new URL(request.url).protocol === "https:";
    const parts   = [
        `${name}=`,
        "Path=/",
        "Max-Age=0",
        "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
        isHttps ? "SameSite=None" : "SameSite=Lax"
    ];
    if (isHttps)                    parts.push("Secure");
    if (options.httpOnly !== false) parts.push("HttpOnly");
    return parts.join("; ");
}

// ════════════════════════════════════════════════════════════
// Response helpers
// ════════════════════════════════════════════════════════════

function jsonResponse(body, status, corsHeaders) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
}

function createJsonHeaders(corsHeaders) {
    return new Headers({ ...corsHeaders, "Content-Type": "application/json" });
}

// ════════════════════════════════════════════════════════════
// String / validation helpers
// ════════════════════════════════════════════════════════════

function sanitizeUsername(username) {
    return (username || "").trim().toLowerCase();
}

function isReservedUsername(username) {
    const n = sanitizeUsername(username);
    return n === "admin" || n.startsWith("dev_") || n.startsWith("supporter_");
}

function bytesToHex(bytes) {
    return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex) {
    const s   = hex || "";
    const out = new Uint8Array(s.length / 2);
    for (let i = 0; i < s.length; i += 2) out[i / 2] = parseInt(s.slice(i, i + 2), 16);
    return out;
}

// ════════════════════════════════════════════════════════════
// Password hashing
// ════════════════════════════════════════════════════════════

async function legacyHashPassword(username, password, env) {
    const salt = env.PASSWORD_SALT;
    if (!salt) throw new Error("PASSWORD_SALT binding is not defined.");
    const data = new TextEncoder().encode(`${username.toLowerCase()}:${password}:${salt}`);
    const buf  = await crypto.subtle.digest("SHA-256", data);
    return bytesToHex(new Uint8Array(buf));
}

async function hashPassword(username, password, env) {
    const pepper = env.PASSWORD_SALT;
    if (!pepper) throw new Error("PASSWORD_SALT binding is not defined.");

    const saltBytes = new Uint8Array(16);
    crypto.getRandomValues(saltBytes);

    const keyMaterial = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(`${username.toLowerCase()}:${password}:${pepper}`),
        "PBKDF2",
        false,
        ["deriveBits"]
    );

    const derivedBits = await crypto.subtle.deriveBits(
        { name: "PBKDF2", hash: "SHA-256", salt: saltBytes, iterations: PBKDF2_ITERATIONS },
        keyMaterial,
        PBKDF2_KEY_BYTES * 8
    );

    return `pbkdf2$${PBKDF2_ITERATIONS}$${bytesToHex(saltBytes)}$${bytesToHex(new Uint8Array(derivedBits))}`;
}

async function verifyPassword(username, password, storedHash, env) {
    if (!storedHash) return { valid: false, needsUpgrade: false, isBannedHash: false };
    if (storedHash === "BANNED") return { valid: false, needsUpgrade: false, isBannedHash: true };

    // Legacy SHA-256 hash — verify and signal upgrade to PBKDF2
    if (!storedHash.startsWith("pbkdf2$")) {
        const legacyHash = await legacyHashPassword(username, password, env);
        const match      = legacyHash === storedHash;
        return { valid: match, needsUpgrade: match, isBannedHash: false };
    }

    const parts = storedHash.split("$");
    if (parts.length !== 4) return { valid: false, needsUpgrade: false, isBannedHash: false };

    const iterations  = parseInt(parts[1], 10);
    const saltBytes   = hexToBytes(parts[2]);
    const expectedHex = parts[3];
    const pepper      = env.PASSWORD_SALT;
    if (!pepper) throw new Error("PASSWORD_SALT binding is not defined.");

    const keyMaterial = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(`${username.toLowerCase()}:${password}:${pepper}`),
        "PBKDF2",
        false,
        ["deriveBits"]
    );

    const derivedBits = await crypto.subtle.deriveBits(
        { name: "PBKDF2", hash: "SHA-256", salt: saltBytes, iterations },
        keyMaterial,
        expectedHex.length * 4
    );

    return {
        valid:        bytesToHex(new Uint8Array(derivedBits)) === expectedHex,
        needsUpgrade: false,
        isBannedHash: false
    };
}

// ════════════════════════════════════════════════════════════
// Session management
// ════════════════════════════════════════════════════════════

async function createUserSession(username, env) {
    const normalized = sanitizeUsername(username);
    const token      = crypto.randomUUID();
    const setKey     = `sessions:user:${normalized}`;
    await queryUpstash([
        ["SET",    `session:${token}`, normalized, "EX", String(USER_SESSION_TTL_SECONDS)],
        ["SADD",   setKey, token],
        ["EXPIRE", setKey, String(USER_SESSION_TTL_SECONDS)]
    ], env);
    return token;
}

async function createAdminSession(env) {
    const token = crypto.randomUUID();
    await queryUpstash([
        ["SET",    `session:admin:${token}`, "1", "EX", String(ADMIN_SESSION_TTL_SECONDS)],
        ["SADD",   "sessions:admin", token],
        ["EXPIRE", "sessions:admin", String(ADMIN_SESSION_TTL_SECONDS)]
    ], env);
    return token;
}

async function revokeUserSessionToken(username, token, env) {
    const normalized = sanitizeUsername(username);
    await queryUpstash([
        ["DEL",  `session:${token}`],
        ["SREM", `sessions:user:${normalized}`, token]
    ], env);
}

async function revokeUserSessions(username, env) {
    const normalized = sanitizeUsername(username);
    const setKey     = `sessions:user:${normalized}`;
    const tokens     = await queryUpstash(["SMEMBERS", setKey], env);
    const list       = Array.isArray(tokens) ? tokens : [];

    if (list.length === 0) {
        await queryUpstash(["DEL", setKey], env);
        return 0;
    }

    const cmds = list.map(t => ["DEL", `session:${t}`]);
    cmds.push(["DEL", setKey]);
    await queryUpstash(cmds, env);
    return list.length;
}

async function revokeAdminSessionToken(token, env) {
    await queryUpstash([
        ["DEL",  `session:admin:${token}`],
        ["SREM", "sessions:admin", token]
    ], env);
}

async function getUserSession(request, env, fallbackToken = null) {
    const token = fallbackToken || getCookieValue(request, USER_SESSION_COOKIE);
    if (!token) return null;
    const username = await queryUpstash(["GET", `session:${token}`], env);
    if (!username) return null;
    return { token, username };
}

async function getAdminSession(request, env, fallbackToken = null) {
    const token = fallbackToken
        || request.headers.get("X-Admin-Token")
        || getCookieValue(request, ADMIN_SESSION_COOKIE);
    if (!token) return null;
    const valid = await queryUpstash(["GET", `session:admin:${token}`], env);
    if (!valid) return null;
    return { token };
}

async function verifyAdminSession(request, env) {
    return !!(await getAdminSession(request, env));
}

// ════════════════════════════════════════════════════════════
// Safety evaluation
// ════════════════════════════════════════════════════════════

function evaluateSafetyMultiTier(openaiData) {
    if (!openaiData || !openaiData.results || openaiData.results.length === 0) {
        return { flagged: false };
    }

    const result     = openaiData.results[0];
    const categories = result.categories;
    const scores     = result.category_scores;

    // Tier 1 — Zero-tolerance: sexual content
    if (categories.sexual || categories["sexual/minors"]) {
        return { flagged: true, reason: "SEXUAL" };
    }

    // Tier 2 — Low threshold (0.20): violence and direct threats
    if (scores.violence > 0.20 || scores["harassment/threatening"] > 0.20 || scores["hate/threatening"] > 0.20) {
        return { flagged: true, reason: "VIOLENCE" };
    }

    // Tier 3 — Category match: self-harm and graphic violence
    if (
        categories["self-harm"] ||
        categories["self-harm/intent"] ||
        categories["self-harm/instructions"] ||
        categories["violence/graphic"]
    ) {
        return { flagged: true, reason: "SELF_HARM_OR_GRAPHIC" };
    }

    // Tier 4 — High threshold (0.85): hate/harassment to preserve political speech
    if (scores.hate > 0.85 || scores.harassment > 0.85) {
        return { flagged: true, reason: "HATE_HARASSMENT" };
    }

    return { flagged: false };
}

// ════════════════════════════════════════════════════════════
// Handler: POST /api/moderate-content
// ════════════════════════════════════════════════════════════

async function handleModerateContent(request, env, corsHeaders) {
    try {
        const body = await request.json();
        if (body.text === undefined || body.text === null) {
            return jsonResponse({ status: "ERROR", message: "Missing parameter: text is required." }, 400, corsHeaders);
        }

        const openaiKey = env.OPENAI_API_KEY;
        if (!openaiKey) throw new Error("OPENAI_API_KEY binding is missing.");

        const modResponse = await fetch("https://api.openai.com/v1/moderations", {
            method: "POST",
            headers: { "Authorization": `Bearer ${openaiKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({ input: body.text, model: "omni-moderation-latest" })
        });

        if (!modResponse.ok) throw new Error(`OpenAI moderation HTTP ${modResponse.status}`);

        return jsonResponse(evaluateSafetyMultiTier(await modResponse.json()), 200, corsHeaders);

    } catch (err) {
        return jsonResponse({ status: "ERROR", message: `Moderation gateway failure: ${err.message}` }, 500, corsHeaders);
    }
}

// ════════════════════════════════════════════════════════════
// Handler: GET /api/get-messages
// ════════════════════════════════════════════════════════════

async function handleGetMessages(request, env, corsHeaders) {
    try {
        const messages = await queryUpstash(["LRANGE", "chat:messages", "0", "49"], env);
        return jsonResponse(messages || [], 200, corsHeaders);
    } catch (err) {
        return jsonResponse({ status: "ERROR", message: `Message retrieval failed: ${err.message}` }, 500, corsHeaders);
    }
}

// ════════════════════════════════════════════════════════════
// Handler: POST /api/send-message
// ════════════════════════════════════════════════════════════

async function handleSendMessage(request, env, corsHeaders, ctx) {
    try {
        const body          = await request.json();
        const text          = body.text;
        const sessionToken  = body.sessionToken;
        const ink_device_id = body.ink_device_id || body.fingerprint;

        if (!text) {
            return jsonResponse({ status: "ERROR", message: "Missing parameter: text is required." }, 400, corsHeaders);
        }

        // ── 1. Session resolution (single pipeline) ──────────────────────────
        if (!sessionToken) {
            return jsonResponse({ status: "ERROR", message: "Unauthorized: Invalid or expired session token." }, 401, corsHeaders);
        }

        const authChk = await queryUpstash([
            ["GET", `session:admin:${sessionToken}`],
            ["GET", `session:${sessionToken}`]
        ], env);

        let username = null;
        let isAdmin  = false;

        if (authChk[0].result) {
            username = "Admin";
            isAdmin  = true;
        } else if (authChk[1].result) {
            username = authChk[1].result;
        } else {
            return jsonResponse({ status: "ERROR", message: "Unauthorized: Invalid or expired session token." }, 401, corsHeaders);
        }

        // ── 2. Policy checks (non-admin only) ────────────────────────────────
        if (!isAdmin) {
            if (!ink_device_id) {
                return jsonResponse({ status: "ERROR", message: "Missing parameter: ink_device_id is required." }, 400, corsHeaders);
            }

            if (text.length > 500) {
                return jsonResponse({ status: "ERROR", message: "Payload too large: Messages are limited to 500 characters." }, 413, corsHeaders);
            }

            // Single pipeline: ban/mute + rate-limit + cooldown + duplicate + device binding
            const rateKey = `rate:send-message:${sessionToken}`;
            const chk = await queryUpstash([
                ["GET",    `device:status:${ink_device_id}`],
                ["GET",    `account:status:${username}`],
                ["GET",    `mute:${username}`],
                ["INCR",   rateKey],
                ["EXPIRE", rateKey, "5"],
                ["SET",    "chat:cooldown", "1", "NX", "EX", "1"],
                ["LINDEX", "chat:messages", "0"],
                ["HMGET",  `user:${username}`, "linked_devices"]
            ], env);

            const deviceStatus   = chk[0].result;
            const accountStatus  = chk[1].result;
            const isMuted        = chk[2].result;
            const currentCount   = chk[3].result;
            const cooldownSet    = chk[5].result;
            const lastMessageRaw = chk[6].result;
            const deviceFields   = chk[7].result;

            if (deviceStatus === "BANNED")  return jsonResponse({ status: "ERROR", message: "This hardware node is banned permanently." }, 403, corsHeaders);
            if (accountStatus === "BANNED") return jsonResponse({ status: "ERROR", message: "Access Denied: Your account has been permanently restricted." }, 403, corsHeaders);
            if (isMuted)                    return jsonResponse({ status: "ERROR", message: "Access Denied: You have been temporarily muted by an administrator." }, 403, corsHeaders);

            if (currentCount > 3)    return jsonResponse({ status: "ERROR", message: "Rate limit exceeded: 3 messages per 5 seconds." }, 429, corsHeaders);
            if (cooldownSet === null) return jsonResponse({ status: "ERROR", message: "Slow down! Chat is moving too fast." }, 429, corsHeaders);

            if (lastMessageRaw) {
                try {
                    const lastMsg = JSON.parse(lastMessageRaw);
                    if (lastMsg && lastMsg.text === text) {
                        return jsonResponse({ status: "ERROR", message: "Duplicate message blocked." }, 409, corsHeaders);
                    }
                } catch (_) {}
            }

            let linkedDevices = [];
            try { linkedDevices = JSON.parse(deviceFields[0] || "[]"); } catch (_) {}
            if (linkedDevices.length > 0 && linkedDevices.indexOf(ink_device_id) === -1) {
                return jsonResponse({ status: "ERROR", message: "Unauthorized: Session is not valid for this device." }, 403, corsHeaders);
            }
        }

        // ── 3. Build sanitized message payload ───────────────────────────────
        let maskedUserId = username;
        if (!isAdmin && username.length > 6) {
            maskedUserId = username.substring(0, 5) + "***" + username.substring(username.length - 2);
        }

        const messageObject = {
            text,
            timestamp: Date.now(),
            userId:    maskedUserId,
            role:      isAdmin ? "admin" : "user",
            layout:    "Kindle Paperwhite Pool"
        };

        if (body.replyTo) {
            messageObject.replyTo = {
                userId:    body.replyTo.userId,
                timestamp: body.replyTo.timestamp,
                text:      body.replyTo.text
            };
        }

        const messageStr = JSON.stringify(messageObject);

        // ── 4. Commit immediately ────────────────────────────────────────────
        await queryUpstash([
            ["LPUSH", "chat:messages", messageStr],
            ["LTRIM", "chat:messages", "0", "99"]
        ], env);

        // ── 5. Respond immediately, then moderate in background ───────────────
        // Moderation is async — if flagged the message is deleted after the fact.
        if (!isAdmin && ctx) {
            const openaiKey = env.OPENAI_API_KEY;
            if (openaiKey) {
                ctx.waitUntil((async () => {
                    try {
                        const modResponse = await fetch("https://api.openai.com/v1/moderations", {
                            method:  "POST",
                            headers: { "Authorization": `Bearer ${openaiKey}`, "Content-Type": "application/json" },
                            body:    JSON.stringify({ input: text, model: "omni-moderation-latest" })
                        });
                        if (modResponse.ok) {
                            const evalResult = evaluateSafetyMultiTier(await modResponse.json());
                            if (evalResult.flagged) {
                                await queryUpstash(["LREM", "chat:messages", "1", messageStr], env);
                            }
                        }
                    } catch (_) {}
                })());
            }
        }

        return jsonResponse({ status: "SUCCESS" }, 200, corsHeaders);

    } catch (err) {
        return jsonResponse({ status: "ERROR", message: `Message transmission failed: ${err.message}` }, 500, corsHeaders);
    }
}

// ════════════════════════════════════════════════════════════
// Handler: POST /api/register
// ════════════════════════════════════════════════════════════

async function handleRegister(request, env, corsHeaders) {
    try {
        const body               = await request.json();
        const username           = body.username;
        const password           = body.password;
        const normalizedUsername = sanitizeUsername(username);

        if (!username || !password) {
            return jsonResponse({ status: "ERROR", message: "Missing parameters: username and password are required." }, 400, corsHeaders);
        }

        if (isReservedUsername(username)) {
            return jsonResponse({ status: "ERROR", message: "That username is reserved and cannot be registered." }, 400, corsHeaders);
        }

        const openaiKey = env.OPENAI_API_KEY;
        if (!openaiKey) throw new Error("OPENAI_API_KEY binding is missing.");

        // Username content moderation
        const usernameModResponse = await fetch("https://api.openai.com/v1/moderations", {
            method: "POST",
            headers: { "Authorization": `Bearer ${openaiKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({ input: username, model: "omni-moderation-latest" })
        });

        if (!usernameModResponse.ok) throw new Error(`OpenAI moderation HTTP ${usernameModResponse.status}`);

        const usernameEval = evaluateSafetyMultiTier(await usernameModResponse.json());
        if (usernameEval.flagged) {
            return jsonResponse({ status: "ERROR", message: "Registration rejected: Username violates our community content policy." }, 400, corsHeaders);
        }

        // Check if username is taken
        const userKey     = `user:${normalizedUsername}`;
        const existingRaw = await queryUpstash(["HGETALL", userKey], env);
        const existing    = flatArrayToObject(existingRaw);
        if (existing.password_hash) {
            return jsonResponse({ status: "ERROR", message: "Username is already taken." }, 400, corsHeaders);
        }

        // Generate ink_device_id server-side — client stores the returned value in localStorage
        const inkDeviceId = crypto.randomUUID();

        const passwordHash  = await hashPassword(normalizedUsername, password, env);
        const clientIp      = (request.cf && request.cf.connectingIp) ? request.cf.connectingIp : "127.0.0.1";
        const sessionToken  = await createUserSession(normalizedUsername, env);

        await queryUpstash(["HSET", userKey,
            "password_hash",  passwordHash,
            "linked_devices", JSON.stringify([inkDeviceId]),
            "linked_ips",     JSON.stringify([clientIp])
        ], env);

        const headers = createJsonHeaders(corsHeaders);
        headers.append("Set-Cookie", buildCookie(request, USER_SESSION_COOKIE, sessionToken, { maxAge: USER_SESSION_TTL_SECONDS }));

        return new Response(JSON.stringify({
            status:        "SUCCESS",
            username:      normalizedUsername,
            token:         sessionToken,
            ink_device_id: inkDeviceId
        }), { status: 200, headers });

    } catch (err) {
        return jsonResponse({ status: "ERROR", message: `Registration failed: ${err.message}` }, 500, corsHeaders);
    }
}

// ════════════════════════════════════════════════════════════
// Handler: POST /api/login
// ════════════════════════════════════════════════════════════

async function handleLogin(request, env, corsHeaders) {
    try {
        const clientIp = (request.cf && request.cf.connectingIp) ? request.cf.connectingIp : "127.0.0.1";
        const rateKey  = `rate:login:ip:${clientIp}`;
        const attempts = await queryUpstash(["INCR", rateKey], env);
        if (attempts === 1) await queryUpstash(["EXPIRE", rateKey, "300"], env);
        if (attempts > 10) {
            return jsonResponse({ status: "ERROR", message: "Too many login attempts. Please wait 5 minutes." }, 429, corsHeaders);
        }

        const body               = await request.json();
        const username           = body.username;
        const password           = body.password;
        const normalizedUsername = sanitizeUsername(username);
        const deviceId           = body.ink_device_id || body.fingerprint;

        if (!username || !password) {
            return jsonResponse({ status: "ERROR", message: "Missing parameters: username and password are required." }, 400, corsHeaders);
        }

        if (!deviceId) {
            return jsonResponse({ status: "ERROR", message: "Missing parameter: ink_device_id is required." }, 400, corsHeaders);
        }

        // Device ban check
        const deviceStatus = await queryUpstash(["GET", `device:status:${deviceId}`], env);
        if (deviceStatus === "BANNED") {
            return jsonResponse({ status: "BANNED", message: "This hardware node has been permanently restricted." }, 403, corsHeaders);
        }

        const userKey  = `user:${normalizedUsername}`;
        const userRaw  = await queryUpstash(["HGETALL", userKey], env);
        const userData = flatArrayToObject(userRaw);

        if (!userData.password_hash) {
            return jsonResponse({ status: "ERROR", message: "Invalid username or password." }, 400, corsHeaders);
        }

        // Parallel: account status + password verification
        const [accountStatus, passwordCheck] = await Promise.all([
            queryUpstash(["GET", `account:status:${normalizedUsername}`], env),
            verifyPassword(normalizedUsername, password, userData.password_hash, env)
        ]);

        if (accountStatus === "BANNED" || passwordCheck.isBannedHash) {
            return jsonResponse({ status: "BANNED", message: "This account has been permanently restricted." }, 403, corsHeaders);
        }

        if (!passwordCheck.valid) {
            return jsonResponse({ status: "ERROR", message: "Invalid username or password." }, 400, corsHeaders);
        }

        // Device binding enforcement
        let linkedDevices = [];
        try { linkedDevices = JSON.parse(userData.linked_devices || "[]"); } catch (_) {}

        if (linkedDevices.length === 0) {
            linkedDevices.push(deviceId);
        } else if (linkedDevices.indexOf(deviceId) === -1) {
            return jsonResponse({ status: "ERROR", message: "This device is not authorized for that account." }, 403, corsHeaders);
        }

        // IP logging
        let linkedIps = [];
        try { linkedIps = JSON.parse(userData.linked_ips || "[]"); } catch (_) {}
        if (clientIp && linkedIps.indexOf(clientIp) === -1) linkedIps.push(clientIp);

        const sessionToken = await createUserSession(normalizedUsername, env);

        if (passwordCheck.needsUpgrade) {
            const upgradedHash = await hashPassword(normalizedUsername, password, env);
            await queryUpstash(["HSET", userKey,
                "password_hash",  upgradedHash,
                "linked_devices", JSON.stringify(linkedDevices),
                "linked_ips",     JSON.stringify(linkedIps)
            ], env);
        } else {
            await queryUpstash(["HSET", userKey,
                "linked_devices", JSON.stringify(linkedDevices),
                "linked_ips",     JSON.stringify(linkedIps)
            ], env);
        }

        const headers = createJsonHeaders(corsHeaders);
        headers.append("Set-Cookie", buildCookie(request, USER_SESSION_COOKIE, sessionToken, { maxAge: USER_SESSION_TTL_SECONDS }));

        return new Response(JSON.stringify({
            status:        "SUCCESS",
            username:      normalizedUsername,
            token:         sessionToken,
            ink_device_id: deviceId
        }), { status: 200, headers });

    } catch (err) {
        return jsonResponse({ status: "ERROR", message: `Authentication failed: ${err.message}` }, 500, corsHeaders);
    }
}

// ════════════════════════════════════════════════════════════
// Handler: GET /api/session
// ════════════════════════════════════════════════════════════

async function handleSessionInfo(request, env, corsHeaders) {
    try {
        // Accept token from query param as fallback for cross-site cookie environments
        const url        = new URL(request.url);
        const queryToken = url.searchParams.get("token") || null;
        const session    = await getUserSession(request, env, queryToken);

        let inkDeviceId = null;
        if (session) {
            try {
                const deviceFields = await queryUpstash(["HMGET", `user:${session.username}`, "linked_devices"], env);
                const linked = JSON.parse(deviceFields[0] || "[]");
                if (linked.length > 0) inkDeviceId = linked[0];
            } catch (_) {}
        }

        return jsonResponse({
            authenticated: !!session,
            username:      session ? session.username : null,
            token:         session ? session.token    : null,
            ink_device_id: inkDeviceId
        }, 200, corsHeaders);
    } catch (err) {
        return jsonResponse({ authenticated: false, message: `Session lookup failed: ${err.message}` }, 500, corsHeaders);
    }
}

// ════════════════════════════════════════════════════════════
// Handler: POST /api/logout
// ════════════════════════════════════════════════════════════

async function handleLogout(request, env, corsHeaders) {
    try {
        let body = {};
        try { body = await request.json(); } catch (_) {}

        const headers = createJsonHeaders(corsHeaders);
        headers.append("Set-Cookie", clearCookie(request, USER_SESSION_COOKIE));
        headers.append("Set-Cookie", clearCookie(request, ADMIN_SESSION_COOKIE));

        const adminSession = await getAdminSession(request, env, body.adminToken || null);
        if (adminSession) {
            await revokeAdminSessionToken(adminSession.token, env);
            return new Response(JSON.stringify({ status: "SUCCESS", scope: "current-admin-session", revokedCount: 1 }), { status: 200, headers });
        }

        const userSession = await getUserSession(request, env, body.sessionToken || null);
        if (userSession) {
            const allSessions  = body.allSessions !== false;
            const revokedCount = allSessions
                ? await revokeUserSessions(userSession.username, env)
                : (await revokeUserSessionToken(userSession.username, userSession.token, env), 1);

            return new Response(JSON.stringify({
                status:       "SUCCESS",
                scope:        allSessions ? "all-user-sessions" : "current-user-session",
                revokedCount
            }), { status: 200, headers });
        }

        return new Response(JSON.stringify({ status: "SUCCESS", scope: "no-active-session", revokedCount: 0 }), { status: 200, headers });

    } catch (err) {
        return jsonResponse({ status: "ERROR", message: `Logout failed: ${err.message}` }, 500, corsHeaders);
    }
}

// ════════════════════════════════════════════════════════════
// Handler: POST /api/change-password
// ════════════════════════════════════════════════════════════

async function handleChangePassword(request, env, corsHeaders) {
    try {
        const body        = await request.json();
        const oldPassword = body.oldPassword;
        const newPassword = body.newPassword;

        if (!oldPassword || !newPassword) {
            return jsonResponse({ status: "ERROR", message: "Missing parameters: oldPassword and newPassword are required." }, 400, corsHeaders);
        }

        const session = await getUserSession(request, env, body.sessionToken || null);
        if (!session) {
            return jsonResponse({ status: "ERROR", message: "Unauthorized: Invalid or expired session token." }, 401, corsHeaders);
        }

        const username = session.username;
        const userKey  = `user:${username}`;
        const userRaw  = await queryUpstash(["HGETALL", userKey], env);
        const userData = flatArrayToObject(userRaw);

        if (!userData.password_hash) {
            return jsonResponse({ status: "ERROR", message: "User profile not found." }, 404, corsHeaders);
        }

        const passwordCheck = await verifyPassword(username, oldPassword, userData.password_hash, env);
        if (!passwordCheck.valid) {
            return jsonResponse({ status: "ERROR", message: "Incorrect current password." }, 400, corsHeaders);
        }

        const newHash  = await hashPassword(username, newPassword, env);
        await queryUpstash(["HSET", userKey, "password_hash", newHash], env);
        await revokeUserSessions(username, env);

        const newToken = await createUserSession(username, env);
        const headers  = createJsonHeaders(corsHeaders);
        headers.append("Set-Cookie", buildCookie(request, USER_SESSION_COOKIE, newToken, { maxAge: USER_SESSION_TTL_SECONDS }));

        return new Response(JSON.stringify({ status: "SUCCESS", message: "Password updated successfully.", token: newToken }), { status: 200, headers });

    } catch (err) {
        return jsonResponse({ status: "ERROR", message: `Password change failed: ${err.message}` }, 500, corsHeaders);
    }
}

// ════════════════════════════════════════════════════════════
// Handler: POST /api/admin/login
// ════════════════════════════════════════════════════════════

async function handleAdminLogin(request, env, corsHeaders) {
    try {
        const clientIp = (request.cf && request.cf.connectingIp) ? request.cf.connectingIp : "127.0.0.1";
        const rateKey  = `rate:admin_login:${clientIp}`;
        const attempts = await queryUpstash(["INCR", rateKey], env);
        if (attempts === 1) await queryUpstash(["EXPIRE", rateKey, "600"], env);
        if (attempts > 5) {
            return jsonResponse({ status: "ERROR", message: "Too many attempts. Administrative login locked for 10 minutes." }, 429, corsHeaders);
        }

        const expectedPassword = env.ADMIN_PASSWORD;
        if (!expectedPassword) {
            return jsonResponse({ status: "ERROR", message: "Administrative authentication unavailable: credentials unconfigured." }, 500, corsHeaders);
        }

        const body = await request.json();
        if (!body.password || body.password !== expectedPassword) {
            return jsonResponse({ status: "ERROR", message: "Authentication failed: Invalid administrator credentials." }, 401, corsHeaders);
        }

        const adminToken = await createAdminSession(env);
        const headers    = createJsonHeaders(corsHeaders);
        headers.append("Set-Cookie", buildCookie(request, ADMIN_SESSION_COOKIE, adminToken, { maxAge: ADMIN_SESSION_TTL_SECONDS }));

        return new Response(JSON.stringify({ status: "SUCCESS", token: adminToken }), { status: 200, headers });

    } catch (err) {
        return jsonResponse({ status: "ERROR", message: `Admin login failed: ${err.message}` }, 500, corsHeaders);
    }
}

// ════════════════════════════════════════════════════════════
// Handler: GET /api/admin/session
// ════════════════════════════════════════════════════════════

async function handleAdminSessionInfo(request, env, corsHeaders) {
    try {
        const adminSession = await getAdminSession(request, env);
        return jsonResponse({ authenticated: !!adminSession }, 200, corsHeaders);
    } catch (err) {
        return jsonResponse({ authenticated: false, message: `Admin session lookup failed: ${err.message}` }, 500, corsHeaders);
    }
}

// ════════════════════════════════════════════════════════════
// Handler: GET /api/admin/user-lookup
// ════════════════════════════════════════════════════════════

async function handleAdminUserLookup(request, env, corsHeaders) {
    try {
        if (!await verifyAdminSession(request, env)) {
            return jsonResponse({ status: "ERROR", message: "Unauthorized: Invalid or expired administrator session." }, 401, corsHeaders);
        }

        const url      = new URL(request.url);
        const username = url.searchParams.get("username");
        if (!username) {
            return jsonResponse({ status: "ERROR", message: "Missing parameter: username is required." }, 400, corsHeaders);
        }

        const userKey    = `user:${username.toLowerCase()}`;
        const userExists = await queryUpstash(["EXISTS", userKey], env);
        if (!userExists) {
            return jsonResponse({ status: "ERROR", message: "User profile not found." }, 404, corsHeaders);
        }

        // HMGET — password hash never enters worker memory during mod queries
        const fields = await queryUpstash(["HMGET", userKey, "linked_devices", "linked_ips"], env);
        let linkedDevices = [];
        let linkedIps     = [];
        try { linkedDevices = JSON.parse(fields[0] || "[]"); } catch (_) {}
        try { linkedIps     = JSON.parse(fields[1] || "[]"); } catch (_) {}

        const accountStatus = await queryUpstash(["GET", `account:status:${username.toLowerCase()}`], env);
        const isBanned      = accountStatus === "BANNED";

        // IP telemetry pipeline
        let mappedIps = [];
        if (linkedIps.length > 0) {
            const ipPipeline = linkedIps.map(ip => ["GET", `audit:failed_telemetry:${ip}`]);
            const ipResults  = await queryUpstash(ipPipeline, env);
            for (let i = 0; i < linkedIps.length; i++) {
                const count = parseInt(ipResults[i] ? ipResults[i].result : "0", 10) || 0;
                mappedIps.push({ ip: linkedIps[i], failedCount: count });
            }
        }

        // Active session count
        let activeSessionCount = 0;
        const sessionTokens    = await queryUpstash(["SMEMBERS", `sessions:user:${username.toLowerCase()}`], env);
        if (Array.isArray(sessionTokens) && sessionTokens.length > 0) {
            const sessionResults = await queryUpstash(sessionTokens.map(t => ["GET", `session:${t}`]), env);
            for (let i = 0; i < sessionTokens.length; i++) {
                const val = sessionResults[i] ? sessionResults[i].result : null;
                if (val === username.toLowerCase()) activeSessionCount++;
            }
        }

        return jsonResponse({
            status:             "SUCCESS",
            username:           username.toLowerCase(),
            passwordHashStatus: isBanned ? "BANNED" : "ACTIVE",
            linkedDevices,
            linkedIps:          mappedIps,
            activeSessionCount
        }, 200, corsHeaders);

    } catch (err) {
        return jsonResponse({ status: "ERROR", message: `User lookup failed: ${err.message}` }, 500, corsHeaders);
    }
}

// ════════════════════════════════════════════════════════════
// Handler: POST /api/admin/ban
// ════════════════════════════════════════════════════════════

async function handleAdminBan(request, env, corsHeaders) {
    try {
        if (!await verifyAdminSession(request, env)) {
            return jsonResponse({ status: "ERROR", message: "Unauthorized: Invalid or expired administrator session." }, 401, corsHeaders);
        }

        const body   = await request.json();
        const type   = body.type;
        const target = body.target;

        if (!type || !target) {
            return jsonResponse({ status: "ERROR", message: "Missing parameters: type and target are required." }, 400, corsHeaders);
        }

        let revokedCount = 0;

        if (type === "account") {
            await queryUpstash(["SET", `account:status:${target.toLowerCase()}`, "BANNED"], env);
            revokedCount = await revokeUserSessions(target, env);
        } else if (type === "device") {
            await queryUpstash(["SET", `device:status:${target}`, "BANNED"], env);
        } else if (type === "ip") {
            await queryUpstash(["SET", `ip:${target}`, "BANNED"], env);
        } else {
            return jsonResponse({ status: "ERROR", message: "Invalid ban type. Allowed: account, device, ip." }, 400, corsHeaders);
        }

        return jsonResponse({
            status:       "SUCCESS",
            message:      `${type} ban executed on: ${target}`,
            revokedCount
        }, 200, corsHeaders);

    } catch (err) {
        return jsonResponse({ status: "ERROR", message: `Ban failed: ${err.message}` }, 500, corsHeaders);
    }
}

// ════════════════════════════════════════════════════════════
// Handler: POST /api/admin/delete-message
// ════════════════════════════════════════════════════════════

async function handleAdminDeleteMessage(request, env, corsHeaders) {
    try {
        if (!await verifyAdminSession(request, env)) {
            return jsonResponse({ status: "ERROR", message: "Unauthorized: Invalid or expired administrator session." }, 401, corsHeaders);
        }

        const body = await request.json();
        if (!body.messageRaw) {
            return jsonResponse({ status: "ERROR", message: "Missing parameter: messageRaw is required." }, 400, corsHeaders);
        }

        await queryUpstash(["LREM", "chat:messages", "1", body.messageRaw], env);
        return jsonResponse({ status: "SUCCESS", message: "Message deleted." }, 200, corsHeaders);

    } catch (err) {
        return jsonResponse({ status: "ERROR", message: `Message deletion failed: ${err.message}` }, 500, corsHeaders);
    }
}

// ════════════════════════════════════════════════════════════
// Handler: POST /api/admin/purge-messages
// ════════════════════════════════════════════════════════════

async function handleAdminPurgeMessages(request, env, corsHeaders) {
    try {
        if (!await verifyAdminSession(request, env)) {
            return jsonResponse({ status: "ERROR", message: "Unauthorized: Invalid or expired administrator session." }, 401, corsHeaders);
        }

        await queryUpstash(["DEL", "chat:messages"], env);
        return jsonResponse({ status: "SUCCESS", message: "All chat messages purged." }, 200, corsHeaders);

    } catch (err) {
        return jsonResponse({ status: "ERROR", message: `Purge failed: ${err.message}` }, 500, corsHeaders);
    }
}

// ════════════════════════════════════════════════════════════
// Handler: POST /api/admin/mute-user
// ════════════════════════════════════════════════════════════

async function handleAdminMuteUser(request, env, corsHeaders) {
    try {
        if (!await verifyAdminSession(request, env)) {
            return jsonResponse({ status: "ERROR", message: "Unauthorized: Invalid or expired administrator session." }, 401, corsHeaders);
        }

        const body            = await request.json();
        const username        = body.username;
        const durationSeconds = body.durationSeconds;

        if (!username || !durationSeconds) {
            return jsonResponse({ status: "ERROR", message: "Missing parameters: username and durationSeconds are required." }, 400, corsHeaders);
        }

        const duration = parseInt(durationSeconds, 10);
        if (isNaN(duration) || duration <= 0) {
            return jsonResponse({ status: "ERROR", message: "Invalid mute duration." }, 400, corsHeaders);
        }

        await queryUpstash(["SET", `mute:${username.toLowerCase()}`, "1", "EX", String(duration)], env);
        return jsonResponse({ status: "SUCCESS", message: `User ${username} muted for ${duration} seconds.` }, 200, corsHeaders);

    } catch (err) {
        return jsonResponse({ status: "ERROR", message: `Mute failed: ${err.message}` }, 500, corsHeaders);
    }
}

// ════════════════════════════════════════════════════════════
// Handler: POST /api/admin/reset-password
// ════════════════════════════════════════════════════════════

async function handleAdminResetPassword(request, env, corsHeaders) {
    try {
        if (!await verifyAdminSession(request, env)) {
            return jsonResponse({ status: "ERROR", message: "Unauthorized: Invalid or expired administrator session." }, 401, corsHeaders);
        }

        const body        = await request.json();
        const username    = body.username;
        const newPassword = body.newPassword;

        if (!username || !newPassword) {
            return jsonResponse({ status: "ERROR", message: "Missing parameters: username and newPassword are required." }, 400, corsHeaders);
        }

        if (newPassword.length < 4) {
            return jsonResponse({ status: "ERROR", message: "Password must be at least 4 characters." }, 400, corsHeaders);
        }

        const userKey = `user:${username.toLowerCase()}`;
        const exists  = await queryUpstash(["EXISTS", userKey], env);
        if (!exists) {
            return jsonResponse({ status: "ERROR", message: "User profile not found." }, 404, corsHeaders);
        }

        const newHash      = await hashPassword(username.toLowerCase(), newPassword, env);
        await queryUpstash(["HSET", userKey, "password_hash", newHash], env);
        const revokedCount = await revokeUserSessions(username, env);

        return jsonResponse({ status: "SUCCESS", message: `Password reset for ${username}.`, revokedCount }, 200, corsHeaders);

    } catch (err) {
        return jsonResponse({ status: "ERROR", message: `Password reset failed: ${err.message}` }, 500, corsHeaders);
    }
}

// ════════════════════════════════════════════════════════════
// Handler: POST /api/admin/revoke-sessions
// ════════════════════════════════════════════════════════════

async function handleAdminRevokeSessions(request, env, corsHeaders) {
    try {
        if (!await verifyAdminSession(request, env)) {
            return jsonResponse({ status: "ERROR", message: "Unauthorized: Invalid or expired administrator session." }, 401, corsHeaders);
        }

        const body = await request.json();
        if (!body.username) {
            return jsonResponse({ status: "ERROR", message: "Missing parameter: username is required." }, 400, corsHeaders);
        }

        const revokedCount = await revokeUserSessions(body.username, env);
        return jsonResponse({ status: "SUCCESS", message: `Revoked ${revokedCount} session(s) for ${body.username}.`, revokedCount }, 200, corsHeaders);

    } catch (err) {
        return jsonResponse({ status: "ERROR", message: `Session revocation failed: ${err.message}` }, 500, corsHeaders);
    }
}
