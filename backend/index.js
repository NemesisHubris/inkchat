/**
 * InkChat - Cloudflare Worker Secure Telemetry Proxy
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
            "Access-Control-Allow-Methods": "POST, OPTIONS",
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

        // Query standard OpenAI Moderation endpoint using omni-moderation-latest
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
        let isFlagged = false;

        if (data.results && data.results.length > 0) {
            isFlagged = !!data.results[0].flagged;
        }

        if (isFlagged) {
            return new Response(JSON.stringify({ flagged: true }), {
                status: 200,
                headers: { ...corsHeaders, "Content-Type": "application/json" }
            });
        }

        return new Response(JSON.stringify({ flagged: false }), {
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
