/**
 * InkChat - Cloudflare Worker Secure Telemetry, Auth & Messaging Proxy
 * 
 * -------------------------------------------------------------------------
 * SECURE EDGE GATEKEEPER ENGINE (ES MODULE FORMAT)
 * -------------------------------------------------------------------------
 * This Cloudflare Worker script acts as a secure edge proxy. It isolates
 * sensitive keys (Upstash Redis URL/Token, OpenAI API Key) inside Cloudflare's
 * environment bindings, keeping secrets hidden from the client browser.
 * 
 * Directory Location: backend/index.js
 */

const ALLOWED_ORIGINS = [
    "https://chat.kindlemodshelf.me",
    "http://localhost:8000"
];

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const pathname = url.pathname;

        // Hardened Desktop-Only Access Routing: Restrict static admin panel UI to desktop workstations
        if (pathname === "/admin.html") {
            const ua = request.headers.get("User-Agent") || "";
            const isKindleOrMobile = /Kindle|Paperwhite|Silk|Android|iPhone|iPad|iPod|Mobile|Phone/i.test(ua);
            if (isKindleOrMobile) {
                return new Response("Forbidden: Administrative console is strictly restricted to authorized desktop workstations.", {
                    status: 403,
                    headers: { "Content-Type": "text/plain" }
                });
            }
        }

        const clientIp = (request.cf && request.cf.connectingIp) ? request.cf.connectingIp : "127.0.0.1";
        const origin = request.headers.get("Origin");

        // CORS Hardening: Drop requests from unauthorized third-party origins
        if (origin && ALLOWED_ORIGINS.indexOf(origin) === -1) {
            return new Response(JSON.stringify({ error: "CORS Policy: Origin unauthorized." }), {
                status: 403,
                headers: { "Content-Type": "application/json" }
            });
        }

        // Dynamically compute safe CORS headers
        const corsHeaders = {
            "Access-Control-Allow-Origin": origin || "https://chat.kindlemodshelf.me",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization",
            "Access-Control-Max-Age": "86400"
        };

        // IP Ban Check: Check network IP against Upstash ban list before routing any request
        if (clientIp) {
            try {
                const ipCheck = await queryUpstash(["GET", `ip:${clientIp}`], env);
                if (ipCheck === "BANNED") {
                    return new Response(JSON.stringify({
                        error: "Access Denied: Your network IP has been permanently restricted."
                    }), {
                        status: 403,
                        headers: { ...corsHeaders, "Content-Type": "application/json" }
                    });
                }
            } catch (e) {
                // Fail-open gracefully to prevent absolute service disruption if Upstash is unresponsive
                console.error("IP Ban Check Error: ", e);
            }
        }

        // Handle CORS preflight options handshake
        if (request.method === "OPTIONS") {
            return new Response(null, {
                status: 204,
                headers: corsHeaders
            });
        }

        // Security API Route: POST /api/check-hardware
        if (url.pathname === "/api/check-hardware" && request.method === "POST") {
            return await handleCheckHardware(request, env, corsHeaders);
        }

        // Security API Route: POST /api/register-device
        if (url.pathname === "/api/register-device" && request.method === "POST") {
            return await handleRegisterDevice(request, env, corsHeaders);
        }

        // Security API Route: POST /api/moderate-content
        if (url.pathname === "/api/moderate-content" && request.method === "POST") {
            return await handleModerateContent(request, env, corsHeaders);
        }

        // Core Messaging Route: GET /api/get-messages
        if (url.pathname === "/api/get-messages" && request.method === "GET") {
            return await handleGetMessages(request, env, corsHeaders);
        }

        // Core Messaging Route: POST /api/send-message
        if (url.pathname === "/api/send-message" && request.method === "POST") {
            return await handleSendMessage(request, env, corsHeaders);
        }

        // User Authentication Route: POST /api/register
        if (url.pathname === "/api/register" && request.method === "POST") {
            return await handleRegister(request, env, corsHeaders);
        }

        // User Authentication Route: POST /api/login
        if (url.pathname === "/api/login" && request.method === "POST") {
            return await handleLogin(request, env, corsHeaders);
        }

        // Administrative Routes
        if (url.pathname === "/api/admin/login" && request.method === "POST") {
            return await handleAdminLogin(request, env, corsHeaders);
        }

        if (url.pathname === "/api/admin/user-lookup" && request.method === "GET") {
            return await handleAdminUserLookup(request, env, corsHeaders);
        }

        if (url.pathname === "/api/admin/ban" && request.method === "POST") {
            return await handleAdminBan(request, env, corsHeaders);
        }

        // Default Fallback Route
        return new Response(JSON.stringify({ error: "Route not found" }), {
            status: 404,
            headers: {
                ...corsHeaders,
                "Content-Type": "application/json"
            }
        });
    }
};

/**
 * Helper: Outbound Upstash Redis REST Command Executer
 * Patched to strictly validate pipelined command response arrays and catch internal errors.
 */
async function queryUpstash(commandArray, env) {
    const redisUrl = env.UPSTASH_REDIS_REST_URL;
    const redisToken = env.UPSTASH_REDIS_REST_TOKEN;

    if (!redisUrl || !redisToken) {
        throw new Error("Upstash Redis bindings are missing or unconfigured.");
    }

    // Clean trailing slashes out of URL variables
    const endpoint = redisUrl.replace(/\/$/, "");

    const response = await fetch(endpoint, {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${redisToken}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify(commandArray)
    });

    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Upstash REST Gateway HTTP ${response.status}: ${errText}`);
    }

    const data = await response.json();
    
    // Top-level REST response failure check
    if (data.error) {
        throw new Error(`Upstash Database Error: ${data.error}`);
    }

    // Pipeline Check: Inspect each response element for nested errors (Anti-masking patch)
    if (Array.isArray(data)) {
        for (let i = 0; i < data.length; i++) {
            if (data[i] && data[i].error) {
                throw new Error(`Pipeline command index ${i} failed: ${data[i].error}`);
            }
        }
        return data; // Return full response batch for pipeline arrays
    }

    return data.result; // Return result for single commands
}

/**
 * Helper: Convert Upstash HGETALL flat array output into an object
 */
function flatArrayToObject(arr) {
    if (!arr || !Array.isArray(arr)) return {};
    const obj = {};
    for (let i = 0; i < arr.length; i += 2) {
        if (arr[i]) {
            obj[arr[i]] = arr[i + 1];
        }
    }
    return obj;
}

/**
 * Helper: WebCrypto-based Secure Password Hashing
 * Hardening: Integrates password salt secret loaded from env dynamic bindings.
 */
async function hashPassword(username, password, env) {
    const encoder = new TextEncoder();
    const salt = env.PASSWORD_SALT || "inkchat-salt-2026";
    const data = encoder.encode(username.toLowerCase() + ":" + password + ":" + salt);
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
    return hashHex;
}

/**
 * Multi-Tier Safety Guideline Evaluator
 * Integrates custom thresholds to allow ideological speech while blocking physical danger.
 */
function evaluateSafetyMultiTier(openaiData) {
    if (!openaiData || !openaiData.results || openaiData.results.length === 0) {
        return { flagged: false };
    }

    const results = openaiData.results[0];
    const categories = results.categories;
    const scores = results.category_scores;

    // Tier 3: Zero-Tolerance Sexual Content Filter
    if (categories.sexual || categories["sexual/minors"]) {
        return { flagged: true, reason: "SEXUAL" };
    }

    // Tier 2: Low-Threshold Violence & Physical Threat Protection (Threshold: 0.20)
    // Direct threats and physical harm warnings must be isolated
    if (scores.violence > 0.20 || scores["harassment/threatening"] > 0.20 || scores["hate/threatening"] > 0.20) {
        return { flagged: true, reason: "VIOLENCE" };
    }

    // Standard safety fallback for other dangerous categories (self-harm, self-harm/intent, etc.)
    if (categories["self-harm"] || categories["self-harm/intent"] || categories["self-harm/instructions"] || categories["violence/graphic"]) {
        return { flagged: true, reason: "SELF-HARM_OR_GRAPHIC" };
    }

    // Tier 4: High-Threshold Ideological Clearance (Threshold: 0.85)
    // Raises the bar for standard hate and standard harassment to permit robust political discourse
    if (scores.hate > 0.85 || scores.harassment > 0.85) {
        return { flagged: true, reason: "HATE_HARASSMENT" };
    }

    return { flagged: false };
}

/**
 * Handler: POST /api/check-hardware
 */
async function handleCheckHardware(request, env, corsHeaders) {
    try {
        const body = await request.json();
        const fingerprint = body.fingerprint;
        const currentUserId = body.currentUserId; // In token-based sync, this represents the sessionToken

        if (!fingerprint) {
            return new Response(JSON.stringify({ 
                status: "ERROR", 
                message: "Missing parameter: fingerprint is required." 
            }), {
                status: 400,
                headers: { ...corsHeaders, "Content-Type": "application/json" }
            });
        }

        const deviceKey = `device:${fingerprint}`;
        const dbResult = await queryUpstash(["GET", deviceKey], env);

        // Evaluate database return state
        if (dbResult === "BANNED") {
            return new Response(JSON.stringify({
                status: "BANNED",
                message: "Enforcing security policy: This physical hardware node is banned permanently due to usage violations."
            }), {
                status: 403,
                headers: { ...corsHeaders, "Content-Type": "application/json" }
            });
        }

        if (dbResult) {
            const mappedUserId = dbResult; // Bound to username

            // Cryptographic session token verification inside check-hardware handshake
            let verifiedUsername = null;
            if (currentUserId) {
                const sessionUser = await queryUpstash(["GET", `session:${currentUserId}`], env);
                if (sessionUser) {
                    verifiedUsername = sessionUser;
                }
            }

            // Enforce One-Account-Per-Device Rule (Compare verified session username)
            if (verifiedUsername && mappedUserId !== verifiedUsername) {
                return new Response(JSON.stringify({
                    status: "DENIED",
                    message: "Enforcing policy: Only one account allowed per physical device."
                }), {
                    status: 200,
                    headers: { ...corsHeaders, "Content-Type": "application/json" }
                });
            }

            return new Response(JSON.stringify({ status: "ALLOWED" }), {
                status: 200,
                headers: { ...corsHeaders, "Content-Type": "application/json" }
            });
        }

        // Key is empty (clean, unmapped device node)
        return new Response(JSON.stringify({ status: "ALLOWED" }), {
            status: 200,
            headers: { ...corsHeaders, "Content-Type": "application/json" }
        });

    } catch (err) {
        return new Response(JSON.stringify({ 
            status: "ERROR", 
            message: `Internal validation proxy failure: ${err.message}` 
        }), {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
    }
}

/**
 * Handler: POST /api/register-device
 */
async function handleRegisterDevice(request, env, corsHeaders) {
    try {
        const body = await request.json();
        const fingerprint = body.fingerprint;
        const userId = body.userId;

        if (!fingerprint || !userId) {
            return new Response(JSON.stringify({
                status: "ERROR",
                message: "Missing parameters: fingerprint and userId are required."
            }), {
                status: 400,
                headers: { ...corsHeaders, "Content-Type": "application/json" }
            });
        }

        const deviceKey = `device:${fingerprint}`;
        const existingMapping = await queryUpstash(["GET", deviceKey], env);

        if (existingMapping === "BANNED") {
            return new Response(JSON.stringify({
                status: "BANNED",
                message: "This hardware node is banned permanently."
            }), {
                status: 403,
                headers: { ...corsHeaders, "Content-Type": "application/json" }
            });
        }

        // Enforce 1-account-per-device policy on registration
        if (existingMapping && existingMapping !== userId) {
            return new Response(JSON.stringify({
                status: "DENIED",
                message: "Enforcing policy: Only one account allowed per physical device."
            }), {
                status: 403,
                headers: { ...corsHeaders, "Content-Type": "application/json" }
            });
        }

        // Commit permanent association to Redis
        await queryUpstash(["SET", deviceKey, userId], env);

        return new Response(JSON.stringify({ status: "SUCCESS" }), {
            status: 200,
            headers: { ...corsHeaders, "Content-Type": "application/json" }
        });

    } catch (err) {
        return new Response(JSON.stringify({
            status: "ERROR",
            message: `Registration write failure: ${err.message}`
        }), {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
    }
}

/**
 * Handler: POST /api/moderate-content
 * Advanced multi-tier content moderation evaluator.
 */
async function handleModerateContent(request, env, corsHeaders) {
    try {
        const body = await request.json();
        const text = body.text;

        if (text === undefined || text === null) {
            return new Response(JSON.stringify({
                status: "ERROR",
                message: "Missing parameter: text is required."
            }), {
                status: 400,
                headers: { ...corsHeaders, "Content-Type": "application/json" }
            });
        }

        const openaiKey = env.OPENAI_API_KEY;
        if (!openaiKey) {
            throw new Error("OpenAI API key binding is missing or unconfigured.");
        }

        // Dispatch outbound metrics call using standard omni-moderation-latest
        const response = await fetch("https://api.openai.com/v1/moderations", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${openaiKey}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                input: text,
                model: "omni-moderation-latest"
            })
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`OpenAI Moderation Endpoint HTTP ${response.status}: ${errText}`);
        }

        const data = await response.json();
        
        // Multi-tier safety threshold filter evaluation
        const evalResult = evaluateSafetyMultiTier(data);

        return new Response(JSON.stringify(evalResult), {
            status: 200,
            headers: { ...corsHeaders, "Content-Type": "application/json" }
        });

    } catch (err) {
        return new Response(JSON.stringify({
            status: "ERROR",
            message: `Moderate Content gateway failure: ${err.message}`
        }), {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
    }
}

/**
 * Handler: GET /api/get-messages
 * Fetches the 50 most recent messages from "chat:messages".
 */
async function handleGetMessages(request, env, corsHeaders) {
    try {
        // Query the list from index 0 to 49
        const messages = await queryUpstash(["LRANGE", "chat:messages", "0", "49"], env);
        
        return new Response(JSON.stringify(messages || []), {
            status: 200,
            headers: {
                ...corsHeaders,
                "Content-Type": "application/json"
            }
        });
    } catch (err) {
        return new Response(JSON.stringify({
            status: "ERROR",
            message: `Message retrieval failed: ${err.message}`
        }), {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
    }
}

/**
 * Handler: POST /api/send-message
 * Security intercepts, validates rate limits, payload sizes, session tokens, moderates, and pushes messages.
 */
async function handleSendMessage(request, env, corsHeaders) {
    try {
        const body = await request.json();
        const text = body.text;
        const sessionToken = body.sessionToken; // Secure cryptographic token
        const fingerprint = body.fingerprint;

        if (!text || !sessionToken || !fingerprint) {
            return new Response(JSON.stringify({
                status: "ERROR",
                message: "Missing parameter: text, sessionToken, and fingerprint are required."
            }), {
                status: 400,
                headers: { ...corsHeaders, "Content-Type": "application/json" }
            });
        }

        // Global Room Cooldown Check: Stop automated script flooding (429)
        const globalCooldown = await queryUpstash(["GET", "chat:cooldown"], env);
        if (globalCooldown) {
            return new Response(JSON.stringify({
                status: "ERROR",
                message: "Slow down! Chat is moving too fast."
            }), {
                status: 429,
                headers: { ...corsHeaders, "Content-Type": "application/json" }
            });
        }

        // Threat 3: Payload Validation & Size Limits (500 character limit protection)
        if (text.length > 500) {
            return new Response(JSON.stringify({
                status: "ERROR",
                message: "Payload too large: Messages are strictly limited to 500 characters."
            }), {
                status: 413,
                headers: { ...corsHeaders, "Content-Type": "application/json" }
            });
        }

        // Cryptographic Session Token Verification: Query Redis for session token
        const sessionUser = await queryUpstash(["GET", `session:${sessionToken}`], env);
        if (!sessionUser) {
            return new Response(JSON.stringify({
                status: "ERROR",
                message: "Unauthorized: Invalid or expired session token."
            }), {
                status: 401,
                headers: { ...corsHeaders, "Content-Type": "application/json" }
            });
        }
        const username = sessionUser; // Authenticated User ID

        // Threat 2: Application-Level Rate Limiting (Max 3 messages per 5 seconds per token)
        const rateKey = `rate:send-message:${sessionToken}`;
        const currentCount = await queryUpstash(["INCR", rateKey], env);
        if (currentCount === 1) {
            // New window - set 5-second sliding expiration
            await queryUpstash(["EXPIRE", rateKey, "5"], env);
        }
        if (currentCount > 3) {
            return new Response(JSON.stringify({
                status: "ERROR",
                message: "Rate limit exceeded: You can only transmit 3 messages per 5 seconds."
            }), {
                status: 429,
                headers: { ...corsHeaders, "Content-Type": "application/json" }
            });
        }

        // Proactive Security: Enforce device lockout if hardware is BANNED
        const deviceKey = `device:${fingerprint}`;
        const deviceCheck = await queryUpstash(["GET", deviceKey], env);
        if (deviceCheck === "BANNED") {
            return new Response(JSON.stringify({
                status: "ERROR",
                message: "This hardware node is banned permanently."
            }), {
                status: 403,
                headers: { ...corsHeaders, "Content-Type": "application/json" }
            });
        }

        // Active Account Policy: Enforce 1-account-per-device (compare verified username)
        if (deviceCheck && deviceCheck !== username) {
            return new Response(JSON.stringify({
                status: "ERROR",
                message: "Enforcing security policy: Only one account allowed per physical device."
            }), {
                status: 403,
                headers: { ...corsHeaders, "Content-Type": "application/json" }
            });
        }

        // Duplicate Message Blocker: Check if last message matches incoming text (409)
        const lastMessageRaw = await queryUpstash(["LINDEX", "chat:messages", "0"], env);
        if (lastMessageRaw) {
            try {
                const lastMsg = JSON.parse(lastMessageRaw);
                if (lastMsg && lastMsg.text === text) {
                    return new Response(JSON.stringify({
                        status: "ERROR",
                        message: "Duplicate message blocked."
                    }), {
                        status: 409,
                        headers: { ...corsHeaders, "Content-Type": "application/json" }
                    });
                }
            } catch (e) {
                // Ignore parsing errors for older legacy/corrupted formats
            }
        }

        // Security check: OpenAI Content Moderation
        const openaiKey = env.OPENAI_API_KEY;
        if (!openaiKey) {
            throw new Error("OpenAI API key binding is missing.");
        }

        const modResponse = await fetch("https://api.openai.com/v1/moderations", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${openaiKey}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                input: text,
                model: "omni-moderation-latest"
            })
        });

        if (!modResponse.ok) {
            throw new Error(`OpenAI Moderation Endpoint HTTP ${modResponse.status}`);
        }

        const modData = await modResponse.json();
        
        // Multi-tier safety threshold filter evaluation
        const evalResult = evaluateSafetyMultiTier(modData);

        if (evalResult.flagged) {
            return new Response(JSON.stringify({
                status: "ERROR",
                message: `Message blocked: Content policy violation detected [Reason: ${evalResult.reason}].`
            }), {
                status: 400,
                headers: { ...corsHeaders, "Content-Type": "application/json" }
            });
        }

        // Mask the user ID to preserve client anonymity in the logs (e.g. username -> usern***me)
        let maskedUserId = username;
        if (username.length > 6) {
            maskedUserId = username.substring(0, 5) + "***" + username.substring(username.length - 2);
        }

        // Compile clean, structured message object
        const messageObject = {
            text: text,
            timestamp: Date.now(),
            userId: maskedUserId,
            fingerprint: fingerprint.substring(0, 8) + "..." // Shorten signature reference
        };
        const messageObjectString = JSON.stringify(messageObject);

        // Perform optimized pipelined database writes in a single round-trip nested array to reduce latency
        // Latency pipeline safety checks handled securely by queryUpstash array parsers
        await queryUpstash([
            ["LPUSH", "chat:messages", messageObjectString],
            ["LTRIM", "chat:messages", "0", "99"],
            ["SET", "chat:cooldown", "1", "EX", "1"]
        ], env);

        return new Response(JSON.stringify({ status: "SUCCESS" }), {
            status: 200,
            headers: { ...corsHeaders, "Content-Type": "application/json" }
        });

    } catch (err) {
        return new Response(JSON.stringify({
            status: "ERROR",
            message: `Message transmission proxy failed: ${err.message}`
        }), {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
    }
}

/**
 * Handler: POST /api/register
 * Encrypts passwords using environmental dynamic salts, links device mappings.
 */
async function handleRegister(request, env, corsHeaders) {
    try {
        const body = await request.json();
        const username = body.username;
        const password = body.password;
        const fingerprint = body.fingerprint;

        if (!username || !password || !fingerprint) {
            return new Response(JSON.stringify({
                status: "ERROR",
                message: "Missing parameter: Username, password, and fingerprint are required."
            }), {
                status: 400,
                headers: { ...corsHeaders, "Content-Type": "application/json" }
            });
        }

        // Username Moderation: Route username through OpenAI Content Moderation pipeline
        const openaiKey = env.OPENAI_API_KEY;
        if (!openaiKey) {
            throw new Error("OpenAI API key binding is missing.");
        }

        const usernameModResponse = await fetch("https://api.openai.com/v1/moderations", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${openaiKey}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                input: username,
                model: "omni-moderation-latest"
            })
        });

        if (!usernameModResponse.ok) {
            throw new Error(`OpenAI Moderation Endpoint HTTP ${usernameModResponse.status}`);
        }

        const usernameModData = await usernameModResponse.json();
        const usernameEvalResult = evaluateSafetyMultiTier(usernameModData);

        if (usernameEvalResult.flagged) {
            return new Response(JSON.stringify({
                status: "ERROR",
                message: "Registration rejected: Username violates our community content policy."
            }), {
                status: 400,
                headers: { ...corsHeaders, "Content-Type": "application/json" }
            });
        }

        // Hardware Ban Check: Login/Register blocked if signature matches BANNED device list
        const deviceKey = `device:${fingerprint}`;
        const deviceCheck = await queryUpstash(["GET", deviceKey], env);
        if (deviceCheck === "BANNED") {
            return new Response(JSON.stringify({
                status: "BANNED",
                message: "This hardware node has been restricted permanently."
            }), {
                status: 403,
                headers: { ...corsHeaders, "Content-Type": "application/json" }
            });
        }

        // One Account Per Device Validation: Device already mapped to another username
        if (deviceCheck && deviceCheck !== username.toLowerCase()) {
            return new Response(JSON.stringify({
                status: "ERROR",
                message: "Enforcing security policy: This physical device terminal is already registered to another account."
            }), {
                status: 403,
                headers: { ...corsHeaders, "Content-Type": "application/json" }
            });
        }

        // Check user registry
        const userKey = `user:${username.toLowerCase()}`;
        const existingRaw = await queryUpstash(["HGETALL", userKey], env);
        const existingUser = flatArrayToObject(existingRaw);

        if (existingUser.password_hash) {
            return new Response(JSON.stringify({
                status: "ERROR",
                message: "Username is already taken."
            }), {
                status: 400,
                headers: { ...corsHeaders, "Content-Type": "application/json" }
            });
        }

        // Secure hashing via WebCrypto Subtle API (Uses environmental password salt dynamic bindings)
        const passwordHash = await hashPassword(username, password, env);
        const linkedDevicesArray = [fingerprint];

        // Generate Cryptographically Secure Session Token using UUIDv4 standard
        const sessionToken = crypto.randomUUID();

        // Pipeline HSET, device mappings, and session token allocation (30-day EX expiration = 2592000s)
        const clientIp = (request.cf && request.cf.connectingIp) ? request.cf.connectingIp : "127.0.0.1";
        const linkedIpsArray = [clientIp];

        await queryUpstash([
            ["HSET", userKey, "password_hash", passwordHash, "linked_devices", JSON.stringify(linkedDevicesArray), "linked_ips", JSON.stringify(linkedIpsArray)],
            ["SET", deviceKey, username.toLowerCase()],
            ["SET", `session:${sessionToken}`, username.toLowerCase(), "EX", "2592000"]
        ], env);

        return new Response(JSON.stringify({
            status: "SUCCESS",
            username: username.toLowerCase(),
            token: sessionToken
        }), {
            status: 200,
            headers: { ...corsHeaders, "Content-Type": "application/json" }
        });

    } catch (err) {
        return new Response(JSON.stringify({
            status: "ERROR",
            message: `Account registration failed: ${err.message}`
        }), {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
    }
}

/**
 * Handler: POST /api/login
 * Validates password hash via WebCrypto environmental salts, maps tokens.
 */
async function handleLogin(request, env, corsHeaders) {
    try {
        const body = await request.json();
        const username = body.username;
        const password = body.password;
        const fingerprint = body.fingerprint;

        if (!username || !password || !fingerprint) {
            return new Response(JSON.stringify({
                status: "ERROR",
                message: "Missing parameter: Username, password, and fingerprint are required."
            }), {
                status: 400,
                headers: { ...corsHeaders, "Content-Type": "application/json" }
            });
        }

        // Hardware Ban Check: Prevent login attempts from restricted devices
        const deviceKey = `device:${fingerprint}`;
        const deviceCheck = await queryUpstash(["GET", deviceKey], env);
        if (deviceCheck === "BANNED") {
            return new Response(JSON.stringify({
                status: "BANNED",
                message: "This hardware node has been restricted permanently."
            }), {
                status: 403,
                headers: { ...corsHeaders, "Content-Type": "application/json" }
            });
        }

        // Retrieve user hash
        const userKey = `user:${username.toLowerCase()}`;
        const userRaw = await queryUpstash(["HGETALL", userKey], env);
        const userData = flatArrayToObject(userRaw);

        if (!userData.password_hash) {
            return new Response(JSON.stringify({
                status: "ERROR",
                message: "Invalid username or password."
            }), {
                status: 400,
                headers: { ...corsHeaders, "Content-Type": "application/json" }
            });
        }

        // Compare computed hex hash (Uses environmental password salt dynamic bindings)
        const computedHash = await hashPassword(username, password, env);
        if (userData.password_hash !== computedHash) {
            return new Response(JSON.stringify({
                status: "ERROR",
                message: "Invalid username or password."
            }), {
                status: 400,
                headers: { ...corsHeaders, "Content-Type": "application/json" }
            });
        }

        // Verify or append linked devices mapping (Enforce 1-account-per-device rules)
        let linkedDevices = [];
        try {
            linkedDevices = JSON.parse(userData.linked_devices || "[]");
        } catch (e) {
            linkedDevices = [];
        }

        // IP Logging: Parse, verify, and update linked_ips array
        const clientIp = (request.cf && request.cf.connectingIp) ? request.cf.connectingIp : "127.0.0.1";
        let linkedIps = [];
        try {
            linkedIps = JSON.parse(userData.linked_ips || "[]");
        } catch (e) {
            linkedIps = [];
        }

        if (clientIp && linkedIps.indexOf(clientIp) === -1) {
            linkedIps.push(clientIp);
        }

        // Generate Cryptographically Secure Session Token using UUIDv4 standard
        const sessionToken = crypto.randomUUID();
        const sessionExpirySeconds = "2592000"; // 30 Days

        if (linkedDevices.indexOf(fingerprint) === -1) {
            // Check if this device is already registered to ANOTHER user
            if (deviceCheck && deviceCheck !== username.toLowerCase()) {
                return new Response(JSON.stringify({
                    status: "ERROR",
                    message: "Enforcing security policy: This physical device terminal is bound to another user account."
                }), {
                    status: 403,
                    headers: { ...corsHeaders, "Content-Type": "application/json" }
                });
            }

            linkedDevices.push(fingerprint);
            
            // Execute atomic update writes to sync database references, save session token, and update IP list
            await queryUpstash([
                ["HSET", userKey, "linked_devices", JSON.stringify(linkedDevices), "linked_ips", JSON.stringify(linkedIps)],
                ["SET", deviceKey, username.toLowerCase()],
                ["SET", `session:${sessionToken}`, username.toLowerCase(), "EX", sessionExpirySeconds]
            ], env);
        } else {
            // Devices matched - save session token and update IP list
            await queryUpstash([
                ["HSET", userKey, "linked_ips", JSON.stringify(linkedIps)],
                ["SET", `session:${sessionToken}`, username.toLowerCase(), "EX", sessionExpirySeconds]
            ], env);
        }

        return new Response(JSON.stringify({
            status: "SUCCESS",
            username: username.toLowerCase(),
            token: sessionToken
        }), {
            status: 200,
            headers: { ...corsHeaders, "Content-Type": "application/json" }
        });

    } catch (err) {
        return new Response(JSON.stringify({
            status: "ERROR",
            message: `Account authentication failed: ${err.message}`
        }), {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
    }
}

/**
 * Handler: POST /api/admin/login
 * Validates admin security passcode, stores temporary admin session.
 */
async function handleAdminLogin(request, env, corsHeaders) {
    try {
        const body = await request.json();
        const password = body.password;
        const expectedPassword = env.ADMIN_PASSWORD || "inkchat-admin-2026";

        if (!password || password !== expectedPassword) {
            return new Response(JSON.stringify({
                status: "ERROR",
                message: "Authentication failed: Invalid administrator credentials."
            }), {
                status: 401,
                headers: { ...corsHeaders, "Content-Type": "application/json" }
            });
        }

        const adminSessionToken = crypto.randomUUID();
        // Allocate temporary admin session key in Upstash (Expires in 2 hours = 7200 seconds)
        await queryUpstash(["SET", `session:admin:${adminSessionToken}`, "1", "EX", "7200"], env);

        return new Response(JSON.stringify({
            status: "SUCCESS",
            token: adminSessionToken
        }), {
            status: 200,
            headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
    } catch (err) {
        return new Response(JSON.stringify({
            status: "ERROR",
            message: `Admin login failed: ${err.message}`
        }), {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
    }
}

/**
 * Helper: Verify admin session token
 */
async function verifyAdminSession(request, env) {
    const adminToken = request.headers.get("X-Admin-Token");
    if (!adminToken) return false;
    const isValid = await queryUpstash(["GET", `session:admin:${adminToken}`], env);
    return !!isValid;
}

/**
 * Handler: GET /api/admin/user-lookup
 * Pulls user profile details, linked hardware device signatures, and network IPs.
 */
async function handleAdminUserLookup(request, env, corsHeaders) {
    try {
        const url = new URL(request.url);
        const username = url.searchParams.get("username");

        const isAdmin = await verifyAdminSession(request, env);
        if (!isAdmin) {
            return new Response(JSON.stringify({
                status: "ERROR",
                message: "Unauthorized: Invalid or expired administrator session."
            }), {
                status: 401,
                headers: { ...corsHeaders, "Content-Type": "application/json" }
            });
        }

        if (!username) {
            return new Response(JSON.stringify({
                status: "ERROR",
                message: "Missing parameter: username is required."
            }), {
                status: 400,
                headers: { ...corsHeaders, "Content-Type": "application/json" }
            });
        }

        const userKey = `user:${username.toLowerCase()}`;
        const userRaw = await queryUpstash(["HGETALL", userKey], env);
        const userData = flatArrayToObject(userRaw);

        if (!userData.password_hash) {
            return new Response(JSON.stringify({
                status: "ERROR",
                message: "User profile not found."
            }), {
                status: 404,
                headers: { ...corsHeaders, "Content-Type": "application/json" }
            });
        }

        let linkedDevices = [];
        try {
            linkedDevices = JSON.parse(userData.linked_devices || "[]");
        } catch (e) {}

        let linkedIps = [];
        try {
            linkedIps = JSON.parse(userData.linked_ips || "[]");
        } catch (e) {}

        return new Response(JSON.stringify({
            status: "SUCCESS",
            username: username.toLowerCase(),
            passwordHashStatus: userData.password_hash === "BANNED" ? "BANNED" : "ACTIVE",
            linkedDevices: linkedDevices,
            linkedIps: linkedIps
        }), {
            status: 200,
            headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
    } catch (err) {
        return new Response(JSON.stringify({
            status: "ERROR",
            message: `User lookup failed: ${err.message}`
        }), {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
    }
}

/**
 * Handler: POST /api/admin/ban
 * Executes atomic administrative ban writes inside Upstash Redis for accounts, devices, or IPs.
 */
async function handleAdminBan(request, env, corsHeaders) {
    try {
        const isAdmin = await verifyAdminSession(request, env);
        if (!isAdmin) {
            return new Response(JSON.stringify({
                status: "ERROR",
                message: "Unauthorized: Invalid or expired administrator session."
            }), {
                status: 401,
                headers: { ...corsHeaders, "Content-Type": "application/json" }
            });
        }

        const body = await request.json();
        const type = body.type; // "account", "device", or "ip"
        const target = body.target;

        if (!type || !target) {
            return new Response(JSON.stringify({
                status: "ERROR",
                message: "Missing parameters: type and target are required."
            }), {
                status: 400,
                headers: { ...corsHeaders, "Content-Type": "application/json" }
            });
        }

        if (type === "account") {
            const userKey = `user:${target.toLowerCase()}`;
            await queryUpstash(["HSET", userKey, "password_hash", "BANNED"], env);
        } else if (type === "device") {
            const deviceKey = `device:${target}`;
            await queryUpstash(["SET", deviceKey, "BANNED"], env);
        } else if (type === "ip") {
            const ipKey = `ip:${target}`;
            await queryUpstash(["SET", ipKey, "BANNED"], env);
        } else {
            return new Response(JSON.stringify({
                status: "ERROR",
                message: "Invalid ban type. Allowed types are: account, device, ip."
            }), {
                status: 400,
                headers: { ...corsHeaders, "Content-Type": "application/json" }
            });
        }

        return new Response(JSON.stringify({
            status: "SUCCESS",
            message: `Successfully executed ${type} ban lockout on target: ${target}`
        }), {
            status: 200,
            headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
    } catch (err) {
        return new Response(JSON.stringify({
            status: "ERROR",
            message: `Admin ban action failed: ${err.message}`
        }), {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
    }
}
