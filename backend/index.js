/**
 * InkChat - Cloudflare Worker Secure Telemetry & Messaging Proxy
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

export default {
    async fetch(request, env, ctx) {
        // Configure standard CORS headers to permit Kindle clients to communicate seamlessly
        const corsHeaders = {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization",
            "Access-Control-Max-Age": "86400"
        };

        // Handle CORS preflight options handshake
        if (request.method === "OPTIONS") {
            return new Response(null, {
                status: 204,
                headers: corsHeaders
            });
        }

        const url = new URL(request.url);

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
    if (data.error) {
        throw new Error(`Upstash Database Error: ${data.error}`);
    }

    return data.result;
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
        const currentUserId = body.currentUserId;

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
                status: 200,
                headers: { ...corsHeaders, "Content-Type": "application/json" }
            });
        }

        if (dbResult) {
            const mappedUserId = dbResult;

            // Enforce One-Account-Per-Device Rule
            if (currentUserId && mappedUserId !== currentUserId) {
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
 * Security intercepts, moderates, and pushes messages into e-ink chat history.
 */
async function handleSendMessage(request, env, corsHeaders) {
    try {
        const body = await request.json();
        const text = body.text;
        const userId = body.userId;
        const fingerprint = body.fingerprint;

        if (!text || !userId || !fingerprint) {
            return new Response(JSON.stringify({
                status: "ERROR",
                message: "Missing parameter: text, userId, and fingerprint are required."
            }), {
                status: 400,
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

        // Active Account Policy: Enforce 1-account-per-device
        if (deviceCheck && deviceCheck !== userId) {
            return new Response(JSON.stringify({
                status: "ERROR",
                message: "Enforcing security policy: Only one account allowed per physical device."
            }), {
                status: 403,
                headers: { ...corsHeaders, "Content-Type": "application/json" }
            });
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

        // Mask the user ID to preserve client anonymity in the logs (e.g. user_72948 -> user_7***8)
        let maskedUserId = userId;
        if (userId.length > 6) {
            maskedUserId = userId.substring(0, 5) + "***" + userId.substring(userId.length - 2);
        }

        // Compile clean, structured message object
        const messageObject = {
            text: text,
            timestamp: Date.now(),
            userId: maskedUserId,
            fingerprint: fingerprint.substring(0, 8) + "..." // Shorten signature reference
        };
        const messageObjectString = JSON.stringify(messageObject);

        // Perform sequential database writes to store & trim (free tier capped at 100 logs)
        await queryUpstash(["LPUSH", "chat:messages", messageObjectString], env);
        await queryUpstash(["LTRIM", "chat:messages", "0", "99"], env);

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
