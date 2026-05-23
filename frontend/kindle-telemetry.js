(function () {
    var isLocal = window.location.hostname === "localhost" ||
                  window.location.hostname === "127.0.0.1" ||
                  window.location.protocol === "file:";
    var localHost = window.location.hostname === "127.0.0.1" ? "127.0.0.1" : "localhost";
    var CONFIG = {
        apiBase:    isLocal ? ("http://" + localHost + ":8787") : "https://slatechat-proxy.kindlemodshelf.workers.dev",
        cookieName: "ink_device_id"
    };

    // ── UUID cookie — session device token ───────────────────────────────────

    function generateUUID() {
        if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
        return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
            var r = Math.random() * 16 | 0;
            return (c === "x" ? r : (r & 0x3 | 0x8)).toString(16);
        });
    }

    function writeCookie(name, value) {
        var exp = new Date();
        exp.setFullYear(exp.getFullYear() + 10);
        document.cookie = name + "=" + encodeURIComponent(value) +
            "; expires=" + exp.toUTCString() + "; path=/; SameSite=Strict";
    }

    function readCookie(name) {
        var prefix = name + "=";
        var parts   = document.cookie.split(";");
        for (var i = 0; i < parts.length; i++) {
            var p = parts[i].trim();
            if (p.indexOf(prefix) === 0) return decodeURIComponent(p.substring(prefix.length));
        }
        return null;
    }

    function getOrCreateDeviceId() {
        var id = null;
        try { id = localStorage.getItem(CONFIG.cookieName); } catch (e) {}
        if (!id) id = readCookie(CONFIG.cookieName);
        if (!id) id = generateUUID();
        writeCookie(CONFIG.cookieName, id);
        try { localStorage.setItem(CONFIG.cookieName, id); } catch (e) {}
        return id;
    }

    // ── Hardware fingerprint — deterministic, survives cookie clears ─────────
    // Collects stable browser+hardware signals and hashes them with FNV-1a.
    // Not perfect (browser updates can shift canvas output) but much harder to
    // fake than a cookie and persists across storage clears.

    function computeHardwareFingerprint() {
        var parts = [];

        // Screen geometry + pixel density
        parts.push("s:"   + screen.width + "x" + screen.height + "x" + screen.colorDepth);
        parts.push("dpr:" + (window.devicePixelRatio || 1));

        // Platform + locale
        parts.push("p:" + (navigator.platform || ""));
        parts.push("l:" + (navigator.language  || ""));

        // Timezone
        parts.push("tz:" + new Date().getTimezoneOffset());
        try { parts.push("tzn:" + Intl.DateTimeFormat().resolvedOptions().timeZone); } catch (e) {}

        // CPU / memory hints (Chrome-only, degrade gracefully)
        parts.push("cpu:" + (navigator.hardwareConcurrency || 0));
        parts.push("mem:" + (navigator.deviceMemory        || 0));
        parts.push("tp:"  + (navigator.maxTouchPoints      || 0));

        // Canvas rendering fingerprint — reflects OS font rendering + GPU compositing
        try {
            var c   = document.createElement("canvas");
            var ctx = c.getContext("2d");
            if (ctx) {
                c.width = 200; c.height = 40;
                ctx.textBaseline = "top";
                ctx.font = "14px Arial";
                ctx.fillStyle = "#f60";
                ctx.fillRect(125, 1, 62, 20);
                ctx.fillStyle = "#069";
                ctx.fillText("InkChat♥", 2, 15);
                ctx.fillStyle = "rgba(102,204,0,0.7)";
                ctx.fillText("InkChat♥", 4, 17);
                parts.push("cv:" + c.toDataURL().slice(-50));
            }
        } catch (e) {}

        // WebGL renderer — identifies GPU model
        try {
            var glc = document.createElement("canvas");
            var gl  = glc.getContext("webgl") || glc.getContext("experimental-webgl");
            if (gl) {
                var dbg = gl.getExtension("WEBGL_debug_renderer_info");
                if (dbg) {
                    parts.push("gl:" + (gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || "") +
                               "|"  + (gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL)   || ""));
                }
            }
        } catch (e) {}

        // FNV-1a 32-bit
        var raw  = parts.join("||");
        var hash = 2166136261;
        for (var i = 0; i < raw.length; i++) {
            hash ^= raw.charCodeAt(i);
            hash  = (hash * 16777619) >>> 0;
        }
        return hash.toString(16);
    }

    // ── XHR helper ───────────────────────────────────────────────────────────

    function xhrPost(url, data, callback) {
        var xhr = new XMLHttpRequest();
        xhr.open("POST", url, true);
        xhr.withCredentials = true;
        xhr.setRequestHeader("Content-Type", "application/json;charset=UTF-8");
        xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4) return;
            if (xhr.status >= 200 && xhr.status < 300) {
                var parsed = null;
                try { parsed = JSON.parse(xhr.responseText); } catch (e) { parsed = xhr.responseText; }
                callback(null, parsed);
            } else {
                var errObj = null;
                try { errObj = JSON.parse(xhr.responseText); } catch (e) {}
                var msg = (errObj && errObj.message) ? errObj.message :
                          (xhr.status === 0 ? "Network error" : (xhr.statusText || "Request failed"));
                var err = new Error(msg);
                err.status = xhr.status;
                callback(err, null);
            }
        };
        xhr.send(JSON.stringify(data));
    }

    // ── Public API ───────────────────────────────────────────────────────────

    window.InkChatEngine = {
        login: function (username, password, deviceId, callback) {
            xhrPost(CONFIG.apiBase + "/api/login", {
                username:             username,
                password:             password,
                ink_device_id:        deviceId,
                hardware_fingerprint: window.InkHardwareFingerprint || null
            }, callback);
        },
        register: function (username, password, deviceId, callback) {
            xhrPost(CONFIG.apiBase + "/api/register", {
                username:             username,
                password:             password,
                ink_device_id:        deviceId,
                hardware_fingerprint: window.InkHardwareFingerprint || null
            }, callback);
        },
        sendMessage: function (text, sessionToken, deviceId, replyTo, callback) {
            xhrPost(CONFIG.apiBase + "/api/send-message", {
                text:          text,
                sessionToken:  sessionToken,
                ink_device_id: deviceId,
                replyTo:       replyTo || null
            }, callback);
        },
        getMessages: function (callback) {
            var xhr = new XMLHttpRequest();
            xhr.open("GET", CONFIG.apiBase + "/api/get-messages", true);
            xhr.withCredentials = true;
            xhr.onreadystatechange = function () {
                if (xhr.readyState !== 4) return;
                if (xhr.status >= 200 && xhr.status < 300) {
                    var parsed = null;
                    try { parsed = JSON.parse(xhr.responseText); } catch (e) { parsed = []; }
                    callback(null, parsed);
                } else {
                    callback(new Error("Failed to fetch messages: HTTP " + xhr.status), null);
                }
            };
            xhr.send(null);
        },
        // WebSocket base URL — used by the main app to connect for real-time updates
        wsBase: isLocal ? ("ws://" + localHost + ":8787") : "wss://slatechat-proxy.kindlemodshelf.workers.dev"
    };

    // ── Init ─────────────────────────────────────────────────────────────────

    function init() {
        if (window.location.pathname.indexOf("admin.html") !== -1) return;

        var deviceId    = getOrCreateDeviceId();
        var fingerprint = computeHardwareFingerprint();

        window.InkDeviceFingerprint   = deviceId;    // UUID cookie (backward compat)
        window.InkDeviceId            = deviceId;
        window.InkHardwareFingerprint = fingerprint; // deterministic hardware hash

        if (typeof window.CustomEvent === "function") {
            window.dispatchEvent(new CustomEvent("inkDeviceReady", {
                detail: { fingerprint: deviceId, hardwareFingerprint: fingerprint }
            }));
        }
    }

    if (window.addEventListener) {
        window.addEventListener("load", init, false);
    } else if (window.attachEvent) {
        window.attachEvent("onload", init);
    } else {
        window.onload = init;
    }
})();
