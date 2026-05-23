export { ChatRoom } from './chat-room.js';

// ── Constants ────────────────────────────────────────────────────────────────

const ALLOWED_ORIGINS = [
    'https://chat.kindlemodshelf.me',
    'https://inkchat.kindlemodshelf.workers.dev',
    'http://localhost:8000'
];

const SESSION_COOKIE       = 'inkchat_session';
const ADMIN_COOKIE         = 'inkchat_admin_session';
const SESSION_TTL          = 2592000;   // 30 days
const ADMIN_SESSION_TTL    = 7200;      // 2 hours
const PBKDF2_ITERATIONS    = 100000;
const PBKDF2_KEY_BYTES     = 32;
const MESSAGE_LIMIT        = 100;       // max stored messages
const MESSAGE_MAX_LENGTH   = 500;

// ── Entry point ──────────────────────────────────────────────────────────────

export default {
    async fetch(request, env, ctx) {
        const url      = new URL(request.url);
        const path     = url.pathname;
        const origin   = request.headers.get('Origin');
        const clientIp = request.headers.get('CF-Connecting-IP') || '127.0.0.1';
        const ua       = request.headers.get('User-Agent') || '';

        // Block admin panel from mobile/Kindle UA
        if (path === '/admin.html' &&
            /Kindle|Paperwhite|Silk|Android|iPhone|iPad|Mobile/i.test(ua)) {
            return new Response('Admin console restricted to desktop.', { status: 403 });
        }

        // CORS
        const isLocalOrigin = origin && (
            origin === 'null' ||
            origin.startsWith('http://localhost:') ||
            origin.startsWith('http://127.0.0.1:')
        );
        if (origin && !isLocalOrigin && !ALLOWED_ORIGINS.includes(origin)) {
            return new Response(JSON.stringify({ error: 'Origin not allowed.' }), {
                status:  403,
                headers: { 'Content-Type': 'application/json' }
            });
        }
        const cors = buildCorsHeaders(origin);

        // IP ban — fail-open (allow traffic if Redis is unreachable)
        try {
            const banned = await redis(['GET', `ip:${clientIp}`], env);
            if (banned === 'BANNED') return json({ error: 'Access denied.' }, 403, cors);
        } catch (_) {}

        if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

        // Route dispatch
        if (path === '/ws') return handleWs(request, env);

        if (path === '/api/get-messages'          && request.method === 'GET')  return getMessages(request, env, cors);
        if (path === '/api/send-message'          && request.method === 'POST') return sendMessage(request, env, cors, ctx);
        if (path === '/api/register'              && request.method === 'POST') return register(request, env, cors);
        if (path === '/api/login'                 && request.method === 'POST') return login(request, env, cors);
        if (path === '/api/session'               && request.method === 'GET')  return sessionInfo(request, env, cors);
        if (path === '/api/logout'                && request.method === 'POST') return logout(request, env, cors);
        if (path === '/api/change-password'       && request.method === 'POST') return changePassword(request, env, cors);
        if (path === '/api/admin/login'           && request.method === 'POST') return adminLogin(request, env, cors);
        if (path === '/api/admin/session'         && request.method === 'GET')  return adminSession(request, env, cors);
        if (path === '/api/admin/user-lookup'     && request.method === 'GET')  return adminUserLookup(request, env, cors);
        if (path === '/api/admin/ban'             && request.method === 'POST') return adminBan(request, env, cors);
        if (path === '/api/admin/delete-message'  && request.method === 'POST') return adminDeleteMessage(request, env, cors);
        if (path === '/api/admin/purge-messages'  && request.method === 'POST') return adminPurgeMessages(request, env, cors);
        if (path === '/api/admin/mute-user'       && request.method === 'POST') return adminMuteUser(request, env, cors);
        if (path === '/api/admin/reset-password'  && request.method === 'POST') return adminResetPassword(request, env, cors);
        if (path === '/api/admin/revoke-sessions' && request.method === 'POST') return adminRevokeSessions(request, env, cors);

        return json({ error: 'Not found.' }, 404, cors);
    }
};

// ── WebSocket ────────────────────────────────────────────────────────────────

async function handleWs(request, env) {
    if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('Expected WebSocket upgrade.', { status: 426 });
    }
    if (!env.CHAT_ROOM) return new Response('WebSocket unavailable.', { status: 503 });
    const stub = env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName('main'));
    return stub.fetch(request);
}

function broadcastNotify(env, ctx) {
    if (!env.CHAT_ROOM || !ctx) return;
    const stub = env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName('main'));
    ctx.waitUntil(stub.fetch(new Request('https://internal/broadcast', {
        method: 'POST',
        body:   JSON.stringify({ type: 'notify' })
    })));
}

// ── IP geo ───────────────────────────────────────────────────────────────────

function extractGeo(request) {
    const cf = request.cf || {};
    return {
        country: cf.country        || null,
        city:    cf.city           || null,
        region:  cf.region         || null,
        postal:  cf.postalCode     || null,
        lat:     cf.latitude       || null,
        lon:     cf.longitude      || null,
        asn:     cf.asn            || null,
        org:     cf.asOrganization || null,
        tz:      cf.timezone       || null
    };
}

async function storeGeo(ip, geo, env) {
    try {
        await redis(['SET', `ip_geo:${ip}`,
            JSON.stringify({ ...geo, ip, ts: Date.now() }),
            'EX', String(86400 * 90)
        ], env);
    } catch (_) {}
}

// ── Redis ────────────────────────────────────────────────────────────────────

async function redis(cmd, env) {
    const url   = env.UPSTASH_REDIS_REST_URL;
    const token = env.UPSTASH_REDIS_REST_TOKEN;
    if (!url || !token) throw new Error('Upstash bindings missing.');

    const isPipeline = Array.isArray(cmd[0]);
    const endpoint   = url.replace(/\/$/, '') + (isPipeline ? '/pipeline' : '');

    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    let resp;
    try {
        resp = await fetch(endpoint, {
            method:  'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body:    JSON.stringify(cmd),
            signal:  ctrl.signal
        });
    } finally {
        clearTimeout(timer);
    }

    if (!resp.ok) throw new Error(`Upstash HTTP ${resp.status}: ${await resp.text()}`);
    const data = await resp.json();
    if (data.error) throw new Error(`Upstash error: ${data.error}`);

    if (Array.isArray(data)) {
        for (let i = 0; i < data.length; i++) {
            if (data[i]?.error) throw new Error(`Pipeline[${i}]: ${data[i].error}`);
        }
        return data;
    }
    return data.result;
}

function flatMap(arr) {
    if (!Array.isArray(arr)) return {};
    const obj = {};
    for (let i = 0; i < arr.length - 1; i += 2) {
        if (arr[i]) obj[arr[i]] = arr[i + 1];
    }
    return obj;
}

// ── Cookies ──────────────────────────────────────────────────────────────────

function getCookie(request, name) {
    const raw = request.headers.get('Cookie') || '';
    for (const part of raw.split(';')) {
        const sep = part.indexOf('=');
        if (sep === -1) continue;
        if (part.slice(0, sep).trim() === name) {
            return decodeURIComponent(part.slice(sep + 1).trim());
        }
    }
    return null;
}

function setCookieHeader(request, name, value, maxAge) {
    const https = new URL(request.url).protocol === 'https:';
    const parts = [
        `${name}=${encodeURIComponent(value)}`,
        'Path=/',
        `Max-Age=${maxAge}`,
        https ? 'SameSite=None' : 'SameSite=Lax',
        'HttpOnly'
    ];
    if (https) parts.push('Secure');
    return parts.join('; ');
}

function clearCookieHeader(request, name) {
    const https = new URL(request.url).protocol === 'https:';
    const parts = [
        `${name}=`,
        'Path=/',
        'Max-Age=0',
        'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
        https ? 'SameSite=None' : 'SameSite=Lax',
        'HttpOnly'
    ];
    if (https) parts.push('Secure');
    return parts.join('; ');
}

// ── Response helpers ─────────────────────────────────────────────────────────

const SEC_HEADERS = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options':        'DENY',
    'Referrer-Policy':        'no-referrer'
};

function json(body, status, corsHeaders) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { ...corsHeaders, ...SEC_HEADERS, 'Content-Type': 'application/json' }
    });
}

function jsonWithCookies(body, status, corsHeaders, cookies) {
    const headers = new Headers({ ...corsHeaders, ...SEC_HEADERS, 'Content-Type': 'application/json' });
    for (const c of cookies) headers.append('Set-Cookie', c);
    return new Response(JSON.stringify(body), { status, headers });
}

function buildCorsHeaders(origin) {
    return {
        'Access-Control-Allow-Origin':      origin || ALLOWED_ORIGINS[0],
        'Access-Control-Allow-Methods':     'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers':     'Content-Type, Authorization, X-Admin-Token',
        'Access-Control-Allow-Credentials': 'true',
        'Access-Control-Max-Age':           '86400',
        'Vary':                             'Origin'
    };
}

// ── String helpers ───────────────────────────────────────────────────────────

function normalize(username) {
    return (username || '').trim().toLowerCase();
}

function isReserved(username) {
    const n = normalize(username);
    return n === 'admin' || n.startsWith('dev_') || n.startsWith('supporter_');
}


function bytesToHex(bytes) {
    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex) {
    const out = new Uint8Array((hex || '').length / 2);
    for (let i = 0; i < hex.length; i += 2) out[i / 2] = parseInt(hex.slice(i, i + 2), 16);
    return out;
}

// ── Password hashing ─────────────────────────────────────────────────────────

async function hashLegacy(username, password, env) {
    const data = new TextEncoder().encode(`${username}:${password}:${env.PASSWORD_SALT}`);
    return bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', data)));
}

async function hashPassword(username, password, env) {
    const pepper = env.PASSWORD_SALT;
    if (!pepper) throw new Error('PASSWORD_SALT not configured.');

    const salt = new Uint8Array(16);
    crypto.getRandomValues(salt);

    const key = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(`${username}:${password}:${pepper}`),
        'PBKDF2', false, ['deriveBits']
    );
    const bits = await crypto.subtle.deriveBits(
        { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITERATIONS },
        key, PBKDF2_KEY_BYTES * 8
    );
    return `pbkdf2$${PBKDF2_ITERATIONS}$${bytesToHex(salt)}$${bytesToHex(new Uint8Array(bits))}`;
}

async function verifyPassword(username, password, stored, env) {
    if (!stored) return { valid: false, upgrade: false, banned: false };
    if (stored === 'BANNED') return { valid: false, upgrade: false, banned: true };

    if (!stored.startsWith('pbkdf2$')) {
        const match = (await hashLegacy(username, password, env)) === stored;
        return { valid: match, upgrade: match, banned: false };
    }

    const [, iter, saltHex, expectedHex] = stored.split('$');
    const pepper = env.PASSWORD_SALT;
    if (!pepper) throw new Error('PASSWORD_SALT not configured.');

    const key = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(`${username}:${password}:${pepper}`),
        'PBKDF2', false, ['deriveBits']
    );
    const bits = await crypto.subtle.deriveBits(
        { name: 'PBKDF2', hash: 'SHA-256', salt: hexToBytes(saltHex), iterations: parseInt(iter, 10) },
        key, expectedHex.length * 4
    );
    return {
        valid:   bytesToHex(new Uint8Array(bits)) === expectedHex,
        upgrade: false,
        banned:  false
    };
}

// ── Sessions ─────────────────────────────────────────────────────────────────

async function createSession(username, env) {
    const token  = crypto.randomUUID();
    const setKey = `sessions:user:${username}`;
    await redis([
        ['SET',    `session:${token}`, username, 'EX', String(SESSION_TTL)],
        ['SADD',   setKey, token],
        ['EXPIRE', setKey, String(SESSION_TTL)]
    ], env);
    return token;
}

async function createAdminSession(env) {
    const token = crypto.randomUUID();
    await redis([
        ['SET',    `session:admin:${token}`, '1', 'EX', String(ADMIN_SESSION_TTL)],
        ['SADD',   'sessions:admin', token],
        ['EXPIRE', 'sessions:admin', String(ADMIN_SESSION_TTL)]
    ], env);
    return token;
}

async function resolveSession(request, env, fallback) {
    const token = fallback || getCookie(request, SESSION_COOKIE);
    if (!token) return null;
    const username = await redis(['GET', `session:${token}`], env);
    return username ? { token, username } : null;
}

async function resolveAdminSession(request, env, fallback) {
    const token = fallback
        || request.headers.get('X-Admin-Token')
        || getCookie(request, ADMIN_COOKIE);
    if (!token) return null;
    const valid = await redis(['GET', `session:admin:${token}`], env);
    return valid ? { token } : null;
}

async function revokeSession(username, token, env) {
    await redis([
        ['DEL',  `session:${token}`],
        ['SREM', `sessions:user:${username}`, token]
    ], env);
}

async function revokeAllSessions(username, env) {
    const setKey = `sessions:user:${username}`;
    const tokens = await redis(['SMEMBERS', setKey], env);
    const list   = Array.isArray(tokens) ? tokens : [];
    if (list.length === 0) { await redis(['DEL', setKey], env); return 0; }
    const cmds = list.map(t => ['DEL', `session:${t}`]);
    cmds.push(['DEL', setKey]);
    await redis(cmds, env);
    return list.length;
}

// ── Content moderation ───────────────────────────────────────────────────────

function evalModeration(data) {
    if (!data?.results?.[0]) return { flagged: false };
    const { categories: c, category_scores: s } = data.results[0];
    if (c.sexual || c['sexual/minors'])                                           return { flagged: true, reason: 'SEXUAL' };
    if (s.violence > 0.20 || s['harassment/threatening'] > 0.20 || s['hate/threatening'] > 0.20)
                                                                                  return { flagged: true, reason: 'VIOLENCE' };
    if (c['self-harm'] || c['self-harm/intent'] || c['self-harm/instructions'] || c['violence/graphic'])
                                                                                  return { flagged: true, reason: 'SELF_HARM' };
    if (s.hate > 0.85 || s.harassment > 0.85)                                    return { flagged: true, reason: 'HATE' };
    return { flagged: false };
}

async function moderate(text, env) {
    const key = env.OPENAI_API_KEY;
    if (!key) return { flagged: false };
    const resp = await fetch('https://api.openai.com/v1/moderations', {
        method:  'POST',
        headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ input: text, model: 'omni-moderation-latest' })
    });
    if (!resp.ok) throw new Error(`OpenAI HTTP ${resp.status}`);
    return evalModeration(await resp.json());
}

// ── Handler: GET /api/get-messages ───────────────────────────────────────────

async function getMessages(request, env, cors) {
    try {
        const msgs = await redis(['LRANGE', 'chat:messages', '0', '49'], env);
        return json(msgs || [], 200, cors);
    } catch (err) {
        return json({ status: 'ERROR', message: err.message }, 500, cors);
    }
}

// ── Handler: POST /api/send-message ─────────────────────────────────────────

async function sendMessage(request, env, cors, ctx) {
    try {
        const body      = await request.json();
        const text     = (body.text || '').trim();
        const deviceId = body.ink_device_id;
        // Accept token from body or fall back to cookies (handles admin cookie-only sessions)
        const token    = body.sessionToken || getCookie(request, ADMIN_COOKIE) || getCookie(request, SESSION_COOKIE);

        if (!text)  return json({ status: 'ERROR', message: 'text is required.' }, 400, cors);
        if (!token) return json({ status: 'ERROR', message: 'Unauthorized.' }, 401, cors);

        // Resolve session (user or admin)
        const authChk = await redis([
            ['GET', `session:admin:${token}`],
            ['GET', `session:${token}`]
        ], env);

        let username = null, isAdmin = false;
        if (authChk[0].result)      { username = 'Admin'; isAdmin = true; }
        else if (authChk[1].result) { username = authChk[1].result; }
        else return json({ status: 'ERROR', message: 'Unauthorized.' }, 401, cors);

        // Policy checks (non-admin only)
        if (!isAdmin) {
            if (!deviceId) return json({ status: 'ERROR', message: 'ink_device_id required.' }, 400, cors);
            if (text.length > MESSAGE_MAX_LENGTH) {
                return json({ status: 'ERROR', message: `Max ${MESSAGE_MAX_LENGTH} characters.` }, 413, cors);
            }

            const rateKey = `rate:send:${token}`;
            const chk = await redis([
                ['GET',    `device:status:${deviceId}`],
                ['GET',    `account:status:${username}`],
                ['GET',    `mute:${username}`],
                ['INCR',   rateKey],
                ['EXPIRE', rateKey, '5'],
                ['SET',    'chat:cooldown', '1', 'NX', 'EX', '1'],
                ['LINDEX', 'chat:messages', '0'],
                ['HMGET',  `user:${username}`, 'linked_devices']
            ], env);

            if (chk[0].result === 'BANNED')  return json({ status: 'ERROR', message: 'This device is banned.' }, 403, cors);
            if (chk[1].result === 'BANNED')  return json({ status: 'ERROR', message: 'This account is banned.' }, 403, cors);
            if (chk[2].result)               return json({ status: 'ERROR', message: 'You are muted.' }, 403, cors);
            if (chk[3].result > 3)           return json({ status: 'ERROR', message: 'Rate limit: 3 messages per 5s.' }, 429, cors);
            if (chk[5].result === null)      return json({ status: 'ERROR', message: 'Slow down.' }, 429, cors);

            if (chk[6].result) {
                try {
                    const last = JSON.parse(chk[6].result);
                    if (last?.text === text) return json({ status: 'ERROR', message: 'Duplicate blocked.' }, 409, cors);
                } catch (_) {}
            }

            let linkedDevices = [];
            try { linkedDevices = JSON.parse(chk[7].result[0] || '[]'); } catch (_) {}
            if (linkedDevices.length > 0 && !linkedDevices.includes(deviceId)) {
                return json({ status: 'ERROR', message: 'Session not valid for this device.' }, 403, cors);
            }
        }

        // Build message object
        const msg = {
            text,
            timestamp: Date.now(),
            userId:    isAdmin ? 'Admin' : username,
            role:      isAdmin ? 'admin' : 'user'
        };
        if (body.replyTo) {
            msg.replyTo = {
                userId:    body.replyTo.userId,
                timestamp: body.replyTo.timestamp,
                text:      body.replyTo.text
            };
        }
        // Moderate before storing — block flagged messages outright
        if (!isAdmin && env.OPENAI_API_KEY) {
            try {
                const mod = await moderate(text, env);
                if (mod.flagged) return json({ status: 'ERROR', message: 'Message blocked by content policy.' }, 400, cors);
            } catch (_) {}
        }

        const msgStr = JSON.stringify(msg);

        // Store and broadcast
        await redis([
            ['LPUSH', 'chat:messages', msgStr],
            ['LTRIM', 'chat:messages', '0', String(MESSAGE_LIMIT - 1)]
        ], env);
        broadcastNotify(env, ctx);

        return json({ status: 'SUCCESS' }, 200, cors);

    } catch (err) {
        return json({ status: 'ERROR', message: err.message }, 500, cors);
    }
}

// ── Handler: POST /api/register ──────────────────────────────────────────────

async function register(request, env, cors) {
    try {
        const clientIp  = request.headers.get('CF-Connecting-IP') || '127.0.0.1';
        const rateKey   = `rate:register:${clientIp}`;
        const attempts  = await redis(['INCR', rateKey], env);
        if (attempts === 1) await redis(['EXPIRE', rateKey, '3600'], env);
        if (attempts > 5)   return json({ status: 'ERROR', message: 'Too many registrations from this address. Try again in 1 hour.' }, 429, cors);

        const body     = await request.json();
        const username = (body.username || '').trim();
        const password = body.password;
        const norm     = normalize(username);

        if (!username || !password) return json({ status: 'ERROR', message: 'username and password required.' }, 400, cors);
        if (password.length < 4)    return json({ status: 'ERROR', message: 'Password must be at least 4 characters.' }, 400, cors);
        if (isReserved(username))   return json({ status: 'ERROR', message: 'That username is reserved.' }, 400, cors);
        if (!/^[a-zA-Z0-9_]+$/.test(username)) {
            return json({ status: 'ERROR', message: 'Username must be alphanumeric only.' }, 400, cors);
        }

        // Moderate username
        try {
            const result = await moderate(username, env);
            if (result.flagged) return json({ status: 'ERROR', message: 'Username violates content policy.' }, 400, cors);
        } catch (_) {}

        const fp      = body.hardware_fingerprint || null;
        const userKey = `user:${norm}`;

        // Check for device already registered (fingerprint reverse index)
        const [existingRaw, fpOwner] = await Promise.all([
            redis(['HGETALL', userKey], env),
            fp ? redis(['GET', `fp_to_user:${fp}`], env) : Promise.resolve(null)
        ]);
        const existing = flatMap(existingRaw);
        if (existing.password_hash) return json({ status: 'ERROR', message: 'Username is taken.' }, 400, cors);
        if (fpOwner && fpOwner !== norm) {
            return json({ status: 'ERROR', message: 'This device is already registered to another account. Please log in instead.' }, 403, cors);
        }

        const geo       = extractGeo(request);
        const deviceId  = crypto.randomUUID();
        const hash      = await hashPassword(norm, password, env);
        const token     = await createSession(norm, env);

        await redis(['HSET', userKey,
            'password_hash',       hash,
            'linked_devices',      JSON.stringify([deviceId]),
            'linked_ips',          JSON.stringify([clientIp]),
            'linked_fingerprints', JSON.stringify(fp ? [fp] : [])
        ], env);
        await storeGeo(clientIp, geo, env);
        if (fp) await redis(['SET', `fp_to_user:${fp}`, norm, 'EX', String(86400 * 730)], env);

        return jsonWithCookies(
            { status: 'SUCCESS', username: norm, token, ink_device_id: deviceId },
            200, cors,
            [setCookieHeader(request, SESSION_COOKIE, token, SESSION_TTL)]
        );
    } catch (err) {
        return json({ status: 'ERROR', message: err.message }, 500, cors);
    }
}

// ── Handler: POST /api/login ─────────────────────────────────────────────────

async function login(request, env, cors) {
    try {
        const clientIp = request.headers.get('CF-Connecting-IP') || '127.0.0.1';
        const rateKey  = `rate:login:${clientIp}`;
        const attempts = await redis(['INCR', rateKey], env);
        if (attempts === 1) await redis(['EXPIRE', rateKey, '300'], env);
        if (attempts > 10)  return json({ status: 'ERROR', message: 'Too many attempts. Wait 5 minutes.' }, 429, cors);

        const body     = await request.json();
        const username = (body.username || '').trim();
        const password = body.password;
        const norm     = normalize(username);
        const deviceId = body.ink_device_id;
        const fp       = body.hardware_fingerprint || null;

        if (!username || !password) return json({ status: 'ERROR', message: 'username and password required.' }, 400, cors);
        if (!deviceId)              return json({ status: 'ERROR', message: 'ink_device_id required.' }, 400, cors);

        // Device ban
        const devStatus = await redis(['GET', `device:status:${deviceId}`], env);
        if (devStatus === 'BANNED') return json({ status: 'BANNED', message: 'This device is banned.' }, 403, cors);

        const userKey  = `user:${norm}`;
        const userData = flatMap(await redis(['HGETALL', userKey], env));
        if (!userData.password_hash) return json({ status: 'ERROR', message: 'Invalid username or password.' }, 400, cors);

        const [accountStatus, pwCheck] = await Promise.all([
            redis(['GET', `account:status:${norm}`], env),
            verifyPassword(norm, password, userData.password_hash, env)
        ]);

        if (accountStatus === 'BANNED' || pwCheck.banned) {
            return json({ status: 'BANNED', message: 'This account is banned.' }, 403, cors);
        }
        if (!pwCheck.valid) return json({ status: 'ERROR', message: 'Invalid username or password.' }, 400, cors);

        // Device binding — allow fingerprint fallback when UUID not recognized
        let linkedDevices = [];
        try { linkedDevices = JSON.parse(userData.linked_devices || '[]'); } catch (_) {}

        if (linkedDevices.length === 0) {
            linkedDevices.push(deviceId);
        } else if (!linkedDevices.includes(deviceId)) {
            let authorized = false;
            if (fp) {
                let linkedFp = [];
                try { linkedFp = JSON.parse(userData.linked_fingerprints || '[]'); } catch (_) {}
                if (linkedFp.length > 0 && linkedFp.includes(fp)) {
                    authorized = true;
                    linkedDevices.push(deviceId);
                }
            }
            if (!authorized) return json({ status: 'ERROR', message: 'This device is not authorized.' }, 403, cors);
        }

        const geo = extractGeo(request);
        await storeGeo(clientIp, geo, env);
        let linkedIps = [];
        try { linkedIps = JSON.parse(userData.linked_ips || '[]'); } catch (_) {}
        if (!linkedIps.includes(clientIp)) linkedIps.push(clientIp);

        const token = await createSession(norm, env);

        // Update user record (upgrade hash if legacy)
        const updates = ['linked_devices', JSON.stringify(linkedDevices), 'linked_ips', JSON.stringify(linkedIps)];
        if (pwCheck.upgrade) {
            const newHash = await hashPassword(norm, password, env);
            updates.push('password_hash', newHash);
        }
        await redis(['HSET', userKey, ...updates], env);

        return jsonWithCookies(
            { status: 'SUCCESS', username: norm, token, ink_device_id: deviceId },
            200, cors,
            [setCookieHeader(request, SESSION_COOKIE, token, SESSION_TTL)]
        );
    } catch (err) {
        return json({ status: 'ERROR', message: err.message }, 500, cors);
    }
}

// ── Handler: GET /api/session ────────────────────────────────────────────────

async function sessionInfo(request, env, cors) {
    try {
        const token   = new URL(request.url).searchParams.get('token') || null;
        const session = await resolveSession(request, env, token);

        let inkDeviceId = null;
        if (session) {
            try {
                const fields = await redis(['HMGET', `user:${session.username}`, 'linked_devices'], env);
                const linked = JSON.parse(fields[0] || '[]');
                if (linked.length > 0) inkDeviceId = linked[0];
            } catch (_) {}
        }

        return json({
            authenticated: !!session,
            username:      session?.username || null,
            token:         session?.token    || null,
            ink_device_id: inkDeviceId
        }, 200, cors);
    } catch (err) {
        return json({ authenticated: false, message: err.message }, 500, cors);
    }
}

// ── Handler: POST /api/logout ────────────────────────────────────────────────

async function logout(request, env, cors) {
    try {
        let body = {};
        try { body = await request.json(); } catch (_) {}

        const clearCookies = [
            clearCookieHeader(request, SESSION_COOKIE),
            clearCookieHeader(request, ADMIN_COOKIE)
        ];

        const adminSess = await resolveAdminSession(request, env, body.adminToken || null);
        if (adminSess) {
            await redis([
                ['DEL',  `session:admin:${adminSess.token}`],
                ['SREM', 'sessions:admin', adminSess.token]
            ], env);
            return jsonWithCookies({ status: 'SUCCESS', scope: 'admin', revokedCount: 1 }, 200, cors, clearCookies);
        }

        const userSess = await resolveSession(request, env, body.sessionToken || null);
        if (userSess) {
            const all          = body.allSessions !== false;
            const revokedCount = all
                ? await revokeAllSessions(userSess.username, env)
                : (await revokeSession(userSess.username, userSess.token, env), 1);
            return jsonWithCookies({ status: 'SUCCESS', scope: all ? 'all' : 'current', revokedCount }, 200, cors, clearCookies);
        }

        return jsonWithCookies({ status: 'SUCCESS', scope: 'none', revokedCount: 0 }, 200, cors, clearCookies);
    } catch (err) {
        return json({ status: 'ERROR', message: err.message }, 500, cors);
    }
}

// ── Handler: POST /api/change-password ──────────────────────────────────────

async function changePassword(request, env, cors) {
    try {
        const clientIp = request.headers.get('CF-Connecting-IP') || '127.0.0.1';
        const rateKey  = `rate:chpw:${clientIp}`;
        const attempts = await redis(['INCR', rateKey], env);
        if (attempts === 1) await redis(['EXPIRE', rateKey, '300'], env);
        if (attempts > 5)   return json({ status: 'ERROR', message: 'Too many attempts. Wait 5 minutes.' }, 429, cors);

        const body    = await request.json();
        const oldPw   = body.oldPassword;
        const newPw   = body.newPassword;

        if (!oldPw || !newPw) return json({ status: 'ERROR', message: 'oldPassword and newPassword required.' }, 400, cors);
        if (newPw.length < 4) return json({ status: 'ERROR', message: 'Minimum 4 characters.' }, 400, cors);

        const session = await resolveSession(request, env, body.sessionToken || null);
        if (!session)  return json({ status: 'ERROR', message: 'Unauthorized.' }, 401, cors);

        const userKey  = `user:${session.username}`;
        const userData = flatMap(await redis(['HGETALL', userKey], env));
        if (!userData.password_hash) return json({ status: 'ERROR', message: 'User not found.' }, 404, cors);

        const pwCheck = await verifyPassword(session.username, oldPw, userData.password_hash, env);
        if (!pwCheck.valid) return json({ status: 'ERROR', message: 'Incorrect current password.' }, 400, cors);

        const newHash = await hashPassword(session.username, newPw, env);
        await redis(['HSET', userKey, 'password_hash', newHash], env);
        await revokeAllSessions(session.username, env);

        const newToken = await createSession(session.username, env);
        return jsonWithCookies(
            { status: 'SUCCESS', token: newToken },
            200, cors,
            [setCookieHeader(request, SESSION_COOKIE, newToken, SESSION_TTL)]
        );
    } catch (err) {
        return json({ status: 'ERROR', message: err.message }, 500, cors);
    }
}

// ── Admin: auth check ────────────────────────────────────────────────────────

async function requireAdmin(request, env, cors) {
    const sess = await resolveAdminSession(request, env);
    if (!sess) return json({ status: 'ERROR', message: 'Unauthorized.' }, 401, cors);
    return null;
}

// ── Handler: POST /api/admin/login ───────────────────────────────────────────

async function adminLogin(request, env, cors) {
    try {
        const clientIp = request.headers.get('CF-Connecting-IP') || '127.0.0.1';
        const rateKey  = `rate:admin_login:${clientIp}`;
        const attempts = await redis(['INCR', rateKey], env);
        if (attempts === 1) await redis(['EXPIRE', rateKey, '600'], env);
        if (attempts > 5)   return json({ status: 'ERROR', message: 'Too many attempts. Locked for 10 minutes.' }, 429, cors);

        if (!env.ADMIN_PASSWORD) return json({ status: 'ERROR', message: 'Admin login not configured.' }, 500, cors);

        const body = await request.json();
        if (!body.password || body.password !== env.ADMIN_PASSWORD) {
            return json({ status: 'ERROR', message: 'Invalid admin credentials.' }, 401, cors);
        }

        const token = await createAdminSession(env);
        return jsonWithCookies(
            { status: 'SUCCESS', token },
            200, cors,
            [setCookieHeader(request, ADMIN_COOKIE, token, ADMIN_SESSION_TTL)]
        );
    } catch (err) {
        return json({ status: 'ERROR', message: err.message }, 500, cors);
    }
}

// ── Handler: GET /api/admin/session ─────────────────────────────────────────

async function adminSession(request, env, cors) {
    try {
        const sess = await resolveAdminSession(request, env);
        return json({ authenticated: !!sess }, 200, cors);
    } catch (err) {
        return json({ authenticated: false, message: err.message }, 500, cors);
    }
}

// ── Handler: GET /api/admin/user-lookup ─────────────────────────────────────

async function adminUserLookup(request, env, cors) {
    try {
        const denied = await requireAdmin(request, env, cors);
        if (denied) return denied;

        const username = new URL(request.url).searchParams.get('username');
        if (!username) return json({ status: 'ERROR', message: 'username required.' }, 400, cors);

        const norm    = normalize(username);
        const userKey = `user:${norm}`;
        const exists  = await redis(['EXISTS', userKey], env);
        if (!exists)  return json({ status: 'ERROR', message: 'User not found.' }, 404, cors);

        const [fields, accountStatus, sessionTokens] = await Promise.all([
            redis(['HMGET', userKey, 'linked_devices', 'linked_ips'], env),
            redis(['GET', `account:status:${norm}`], env),
            redis(['SMEMBERS', `sessions:user:${norm}`], env)
        ]);

        let linkedDevices = [], linkedIps = [];
        try { linkedDevices = JSON.parse(fields[0] || '[]'); } catch (_) {}
        try { linkedIps     = JSON.parse(fields[1] || '[]'); } catch (_) {}

        // Geo lookup for all IPs in one pipeline
        let mappedIps = linkedIps.map(ip => ({ ip, geo: null }));
        if (linkedIps.length > 0) {
            const geoResults = await redis(linkedIps.map(ip => ['GET', `ip_geo:${ip}`]), env);
            for (let i = 0; i < linkedIps.length; i++) {
                try { mappedIps[i].geo = JSON.parse(geoResults[i]?.result || null); } catch (_) {}
            }
        }

        // Count valid sessions
        let activeSessions = 0;
        const tokens = Array.isArray(sessionTokens) ? sessionTokens : [];
        if (tokens.length > 0) {
            const sessResults = await redis(tokens.map(t => ['GET', `session:${t}`]), env);
            for (let i = 0; i < tokens.length; i++) {
                if (sessResults[i]?.result === norm) activeSessions++;
            }
        }

        return json({
            status:         'SUCCESS',
            username:       norm,
            banned:         accountStatus === 'BANNED',
            linkedDevices,
            linkedIps:      mappedIps,
            activeSessions
        }, 200, cors);
    } catch (err) {
        return json({ status: 'ERROR', message: err.message }, 500, cors);
    }
}

// ── Handler: POST /api/admin/ban ─────────────────────────────────────────────

async function adminBan(request, env, cors) {
    try {
        const denied = await requireAdmin(request, env, cors);
        if (denied) return denied;

        const { type, target } = await request.json();
        if (!type || !target) return json({ status: 'ERROR', message: 'type and target required.' }, 400, cors);

        let revokedCount = 0;
        if (type === 'account') {
            await redis(['SET', `account:status:${normalize(target)}`, 'BANNED'], env);
            revokedCount = await revokeAllSessions(target, env);
        } else if (type === 'device') {
            await redis(['SET', `device:status:${target}`, 'BANNED'], env);
        } else if (type === 'ip') {
            await redis(['SET', `ip:${target}`, 'BANNED'], env);
        } else {
            return json({ status: 'ERROR', message: 'type must be: account, device, or ip.' }, 400, cors);
        }

        return json({ status: 'SUCCESS', type, target, revokedCount }, 200, cors);
    } catch (err) {
        return json({ status: 'ERROR', message: err.message }, 500, cors);
    }
}

// ── Handler: POST /api/admin/delete-message ──────────────────────────────────

async function adminDeleteMessage(request, env, cors) {
    try {
        const denied = await requireAdmin(request, env, cors);
        if (denied) return denied;

        const { messageRaw } = await request.json();
        if (!messageRaw) return json({ status: 'ERROR', message: 'messageRaw required.' }, 400, cors);

        await redis(['LREM', 'chat:messages', '1', messageRaw], env);
        return json({ status: 'SUCCESS' }, 200, cors);
    } catch (err) {
        return json({ status: 'ERROR', message: err.message }, 500, cors);
    }
}

// ── Handler: POST /api/admin/purge-messages ──────────────────────────────────

async function adminPurgeMessages(request, env, cors) {
    try {
        const denied = await requireAdmin(request, env, cors);
        if (denied) return denied;

        await redis(['DEL', 'chat:messages'], env);
        return json({ status: 'SUCCESS', message: 'All messages purged.' }, 200, cors);
    } catch (err) {
        return json({ status: 'ERROR', message: err.message }, 500, cors);
    }
}

// ── Handler: POST /api/admin/mute-user ───────────────────────────────────────

async function adminMuteUser(request, env, cors) {
    try {
        const denied = await requireAdmin(request, env, cors);
        if (denied) return denied;

        const { username, durationSeconds } = await request.json();
        if (!username || !durationSeconds) {
            return json({ status: 'ERROR', message: 'username and durationSeconds required.' }, 400, cors);
        }
        const dur = parseInt(durationSeconds, 10);
        if (isNaN(dur) || dur <= 0) return json({ status: 'ERROR', message: 'Invalid duration.' }, 400, cors);

        await redis(['SET', `mute:${normalize(username)}`, '1', 'EX', String(dur)], env);
        return json({ status: 'SUCCESS', username, durationSeconds: dur }, 200, cors);
    } catch (err) {
        return json({ status: 'ERROR', message: err.message }, 500, cors);
    }
}

// ── Handler: POST /api/admin/reset-password ──────────────────────────────────

async function adminResetPassword(request, env, cors) {
    try {
        const denied = await requireAdmin(request, env, cors);
        if (denied) return denied;

        const { username, newPassword } = await request.json();
        if (!username || !newPassword)    return json({ status: 'ERROR', message: 'username and newPassword required.' }, 400, cors);
        if (newPassword.length < 4)       return json({ status: 'ERROR', message: 'Minimum 4 characters.' }, 400, cors);

        const norm    = normalize(username);
        const userKey = `user:${norm}`;
        const exists  = await redis(['EXISTS', userKey], env);
        if (!exists)  return json({ status: 'ERROR', message: 'User not found.' }, 404, cors);

        const newHash      = await hashPassword(norm, newPassword, env);
        await redis(['HSET', userKey, 'password_hash', newHash], env);
        const revokedCount = await revokeAllSessions(norm, env);

        return json({ status: 'SUCCESS', username: norm, revokedCount }, 200, cors);
    } catch (err) {
        return json({ status: 'ERROR', message: err.message }, 500, cors);
    }
}

// ── Handler: POST /api/admin/revoke-sessions ─────────────────────────────────

async function adminRevokeSessions(request, env, cors) {
    try {
        const denied = await requireAdmin(request, env, cors);
        if (denied) return denied;

        const { username } = await request.json();
        if (!username) return json({ status: 'ERROR', message: 'username required.' }, 400, cors);

        const revokedCount = await revokeAllSessions(normalize(username), env);
        return json({ status: 'SUCCESS', username, revokedCount }, 200, cors);
    } catch (err) {
        return json({ status: 'ERROR', message: err.message }, 500, cors);
    }
}
