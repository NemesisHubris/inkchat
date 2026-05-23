/**
 * InkChat - E-Ink Telemetry & Anti-Spoof Security Shield
 * 
 * -------------------------------------------------------------------------
 * CLIENT TELEMETRY COMPONENT (STRICT ES5 STANDARDS)
 * -------------------------------------------------------------------------
 * Compatible: Pure ES5 JavaScript. No let, const, arrow functions, promises,
 * template literals, backticks, or async/await. Strictly uses raw XHR.
 * 
 * Directory Location: frontend/kindle-telemetry.js
 */

(function () {
    // Top-Level Configuration
    var CONFIG = {
        apiBase: "https://slatechat-proxy.kindlemodshelf.workers.dev", // Production Cloudflare Worker URL
        checkHardwareEndpoint: "/api/check-hardware",
        moderateContentEndpoint: "/api/moderate-content",
        registerDeviceEndpoint: "/api/register-device",
        cookieName: "ink_device_id", // Renamed to ink_device_id
        currentUserId: null // Set dynamically by application context
    };

    /**
     * Legacy Base64 Encoder Fallback
     */
    function encodeBase64Legacy(str) {
        var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
        var out = [];
        var i = 0;
        var len = str.length;
        var c1, c2, c3;
        while (i < len) {
            c1 = str.charCodeAt(i++) & 0xff;
            if (i === len) {
                out.push(chars.charAt(c1 >> 2));
                out.push(chars.charAt((c1 & 0x3) << 4));
                out.push('==');
                break;
            }
            c2 = str.charCodeAt(i++);
            if (i === len) {
                out.push(chars.charAt(c1 >> 2));
                out.push(chars.charAt(((c1 & 0x3) << 4) | ((c2 & 0xf0) >> 4)));
                out.push(chars.charAt((c2 & 0xf) << 2));
                out.push('=');
                break;
            }
            c3 = str.charCodeAt(i++);
            out.push(chars.charAt(c1 >> 2));
            out.push(chars.charAt(((c1 & 0x3) << 4) | ((c2 & 0xf0) >> 4)));
            out.push(chars.charAt(((c2 & 0xf) << 4) | ((c3 & 0xc0) >> 6)));
            out.push(chars.charAt(c3 & 0x3f));
        }
        return out.join('');
    }

    /**
     * Requirement 1: Whitelist Genuine E-Ink Panels (Anti-Spoof Screening)
     */
    function isGenuineEInkDevice() {
        // Telemetry Isolation: Admin page is completely exempt from hardware spoof checks
        if (typeof window !== "undefined" && window.location && window.location.pathname && window.location.pathname.indexOf("admin.html") !== -1) {
            return true;
        }

        var ua = navigator.userAgent || "";
        var isKindleBrand = ua.indexOf("Kindle") !== -1 || ua.indexOf("Silk") !== -1 || ua.indexOf("Kobo") !== -1;

        if (!isKindleBrand) {
            return false;
        }

        // Spoof Check: Standard PC architectures reporting graphic cards
        try {
            var canvas = document.createElement("canvas");
            var gl = canvas.getContext("webgl") || canvas.getContext("experimental-webgl");
            if (gl) {
                var debugInfo = gl.getExtension("WEBGL_debug_renderer_info");
                if (debugInfo) {
                    var renderer = gl.getParameter(debugInfo.UNMASKED_RENDERER_VENDOR_ID) || "";
                    var vendor = gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL) || "";
                    var fullGpuProfile = (renderer + " " + vendor).toLowerCase();

                    var pcGpuKeywords = ["nvidia", "intel", "amd", "radeon", "geforce", "apple m", "swiftshader", "llvmpipe"];
                    for (var i = 0; i < pcGpuKeywords.length; i++) {
                        if (fullGpuProfile.indexOf(pcGpuKeywords[i]) !== -1) {
                            // Genuine e-ink Kindle displays lack dedicated desktop GPUs
                            return false;
                        }
                    }
                }
            }
        } catch (e) {
            // Failure to fetch WebGL context is expected on legacy monochrome Kindles
        }

        // Color depth check: E-ink Paperwhite displays typically report <= 16 bit depth.
        // Spoofing desktop environments default to 24/32 bits.
        var depth = window.screen.colorDepth || 0;
        if (depth > 16) {
            var isSilkFireTablet = ua.indexOf("Android") !== -1 || ua.indexOf("Silk-Accelerated") !== -1;
            if (!isSilkFireTablet) {
                return false;
            }
        }

        return true;
    }

    /**
     * Requirement 3.2: Legacy WebKit Exception Scraper Fallback
     */
    function scrapeBlobConstructorException() {
        var sig = "blob-untriggered";
        try {
            if (typeof window.Blob === "object" || typeof window.Blob === "function") {
                // Instantiating Blob without array parameters triggers a native WebKit TypeError
                var testBlob = new window.Blob();
                sig = "blob-active";
            } else {
                sig = "blob-missing";
            }
        } catch (e) {
            // Scrapes the unique engine string: "[object BlobConstructor] is not a constructor"
            sig = "blob-err:" + (e.message || e.toString());
        }
        return sig;
    }

    /**
     * Requirement 4: Silicon Lottery Benchmark
     */
    function getSiliconLotteryBenchmark() {
        var runs = [];
        var iterations = 20000;
        var r, i, start, end;

        try {
            for (r = 0; r < 10; r++) {
                start = new Date().getTime();
                for (i = 0; i < iterations; i++) {
                    Math.sin(i);
                }
                end = new Date().getTime();
                runs.push(end - start);
            }

            // Isolate absolute minimum execution duration (fastest run)
            var minDuration = runs[0];
            for (i = 1; i < runs.length; i++) {
                if (runs[i] < minDuration) {
                    minDuration = runs[i];
                }
            }
            return minDuration;
        } catch (e) {
            return -1;
        }
    }

    /**
     * Core Fingerprint Assembly Routine
     */
    function generateStatelessHardwareSignature(callback) {
        var screenWidth = window.screen.width || 0;
        var screenHeight = window.screen.height || 0;
        var screenGeometry = screenWidth + "x" + screenHeight;

        // Requirement 2: Typography Geometry Engine
        var fontGeometry = "font-metrics-failed";
        try {
            var canvas = document.createElement("canvas");
            if (canvas && canvas.getContext) {
                var ctx = canvas.getContext("2d");
                if (ctx) {
                    // Force rendering using native Bookerly / Ember / Caecilia stacks
                    ctx.font = "12px 'Bookerly', 'Amazon Ember', 'Caecilia', serif";
                    var metrics = ctx.measureText("InkChatSecureTelemetryShield-1.0.0-@#$!%*");
                    fontGeometry = metrics.width;
                }
            }
        } catch (e) {
            fontGeometry = "font-err:" + (e.message || e.toString());
        }

        var siliconScore = getSiliconLotteryBenchmark();
        var AudioCtxClass = window.OfflineAudioContext || window.webkitOfflineAudioContext;
        var audioTimeout = null;
        var audioCompleted = false;

        function compileSignature(enginePayload) {
            if (audioTimeout) {
                clearTimeout(audioTimeout);
                audioTimeout = null;
            }
            audioCompleted = true;

            var rawSignature = [
                "screen:" + screenGeometry,
                "font:" + fontGeometry,
                "silicon:" + siliconScore,
                "engine:" + enginePayload
            ].join("|");

            var base64Signature = "";
            try {
                if (typeof window.btoa === "function") {
                    base64Signature = window.btoa(rawSignature);
                } else {
                    base64Signature = encodeBase64Legacy(rawSignature);
                }
            } catch (e) {
                base64Signature = encodeBase64Legacy(rawSignature);
            }

            callback(base64Signature);
        }

        // Requirement 3.1: Modern Chromium OfflineAudioContext triangle compression
        if (AudioCtxClass) {
            try {
                var audioCtx = new AudioCtxClass(1, 44100 * 0.1, 44100);
                
                // Kindle Freeze Watchdog: Stalls resolved via 100ms fallback timeout (Stability patch)
                audioTimeout = setTimeout(function () {
                    if (!audioCompleted) {
                        try {
                            if (audioCtx.oncomplete) audioCtx.oncomplete = null;
                        } catch (e) {}
                        compileSignature(scrapeBlobConstructorException());
                    }
                }, 100);

                var osc = audioCtx.createOscillator();
                var compressor = audioCtx.createDynamicsCompressor();

                osc.type = "triangle";
                osc.frequency.setValueAtTime(1000, 0);

                if (compressor.threshold) {
                    compressor.threshold.setValueAtTime(-50, 0);
                    compressor.knee.setValueAtTime(40, 0);
                    compressor.ratio.setValueAtTime(12, 0);
                    compressor.attack.setValueAtTime(0, 0);
                    compressor.release.setValueAtTime(0.25, 0);
                }

                osc.connect(compressor);
                compressor.connect(audioCtx.destination);

                if (osc.start) {
                    osc.start(0);
                } else if (osc.noteOn) {
                    osc.noteOn(0);
                }

                audioCtx.oncomplete = function (event) {
                    if (audioCompleted) return; // Watchdog already resolved
                    var audioHash = "audio-hash-error";
                    try {
                        var buffer = event.renderedBuffer;
                        var channelData = buffer.getChannelData(0);

                        // 32-bit FNV-1a hash iteration over channel data float points
                        var hash = 2166136261;
                        for (var k = 0; k < channelData.length; k++) {
                            var val = Math.round(channelData[k] * 1000000);
                            hash ^= val;
                            hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
                        }
                        audioHash = "audio:" + (hash >>> 0).toString(16);
                    } catch (e) {
                        audioHash = "audio-processing-fail";
                    }
                    compileSignature(audioHash);
                };

                audioCtx.startRendering();
            } catch (err) {
                compileSignature(scrapeBlobConstructorException());
            }
        } else {
            compileSignature(scrapeBlobConstructorException());
        }
    }

    /**
     * Storage Helpers
     */
    function writeHardCookie(name, value) {
        var date = new Date();
        date.setFullYear(date.getFullYear() + 10); // Strict 10-year expiration
        var expires = "; expires=" + date.toUTCString();
        document.cookie = name + "=" + encodeURIComponent(value) + expires + "; path=/; SameSite=Strict; Secure";
    }

    function readCookie(name) {
        var nameEQ = name + "=";
        var cookieSegments = document.cookie.split(';');
        for (var i = 0; i < cookieSegments.length; i++) {
            var segment = cookieSegments[i];
            while (segment.charAt(0) === ' ') {
                segment = segment.substring(1, segment.length);
            }
            if (segment.indexOf(nameEQ) === 0) {
                return decodeURIComponent(segment.substring(nameEQ.length, segment.length));
            }
        }
        return null;
    }

    function readLocalStorage(key) {
        try {
            if (window.localStorage) {
                return window.localStorage.getItem(key);
            }
        } catch (e) {}
        return null;
    }

    function writeLocalStorage(key, value) {
        try {
            if (window.localStorage) {
                window.localStorage.setItem(key, value);
                return true;
            }
        } catch (e) {}
        return false;
    }

    /**
     * Requirement 5 & 3: Twin-Layer Sync Engine
     * Incorporates Localhost Bypass logic to facilitate seamless desktop reviews.
     */
    function syncLocalStorageAndCookie(callback) {
        var isLocalhost = false;
        try {
            var hostname = window.location.hostname;
            if (hostname === "localhost" || hostname === "127.0.0.1") {
                isLocalhost = true;
            }
        } catch (e) {}

        if (isLocalhost) {
            try {
                console.log("Local development environment detected: Bypassing e-ink hardware enforcement profile.");
            } catch (e) {}
        } else {
            if (!isGenuineEInkDevice()) {
                callback(null, "DESKTOP_SPOOF_DETECTED");
                return;
            }
        }

        var cookieToken = readCookie(CONFIG.cookieName);
        var storageToken = readLocalStorage(CONFIG.cookieName);

        if (cookieToken && !storageToken) {
            // LocalStorage wiped - cross-heal from Cookie
            writeLocalStorage(CONFIG.cookieName, cookieToken);
            callback(cookieToken, null);
        } else if (!cookieToken && storageToken) {
            // Cookie wiped - cross-heal from LocalStorage
            writeHardCookie(CONFIG.cookieName, storageToken);
            callback(storageToken, null);
        } else if (cookieToken && storageToken) {
            // Fully synchronized
            callback(cookieToken, null);
        } else {
            // Both cleared/empty - force generation of immutable stateless hardware identity
            generateStatelessHardwareSignature(function (newSignature) {
                writeHardCookie(CONFIG.cookieName, newSignature);
                writeLocalStorage(CONFIG.cookieName, newSignature);
                callback(newSignature, null);
            });
        }
    }

    /**
     * Raw XHR POST Dispatcher (Pure ES5 compatible)
     */
    function dispatchXhrPost(url, dataPayload, callback) {
        var xhr = null;
        if (window.XMLHttpRequest) {
            xhr = new XMLHttpRequest();
        } else if (window.ActiveXObject) {
            try {
                xhr = new ActiveXObject("Msxml2.XMLHTTP");
            } catch (e) {
                try {
                    xhr = new ActiveXObject("Microsoft.XMLHTTP");
                } catch (el) {}
            }
        }

        if (!xhr) {
            callback(new Error("Browser does not support XHR protocols."), null);
            return;
        }

        xhr.open("POST", url, true);
        xhr.setRequestHeader("Content-Type", "application/json;charset=UTF-8");

        xhr.onreadystatechange = function () {
            if (xhr.readyState === 4) {
                if (xhr.status >= 200 && xhr.status < 300) {
                    var parsedResponse = null;
                    try {
                        parsedResponse = JSON.parse(xhr.responseText);
                    } catch (e) {
                        parsedResponse = xhr.responseText;
                    }
                    callback(null, parsedResponse);
                } else {
                    var msg = "";
                    if (xhr.status === 0) {
                        msg = "Network Disconnection or CORS Blocked";
                    } else {
                        var errObj = null;
                        try {
                            errObj = JSON.parse(xhr.responseText);
                        } catch (e) {}
                        msg = (errObj && errObj.message) ? errObj.message : (xhr.statusText || "");
                    }
                    var err = new Error(msg);
                    err.status = xhr.status;
                    callback(err, null);
                }
            }
        };

        xhr.send(JSON.stringify(dataPayload));
    }

    /**
     * Requirement 6: Execution Gatekeeper Lockout
     */
    function enforceDeviceLockout(alertMessage) {
        // Telemetry Isolation: Admin page is completely exempt from hardware lockouts
        if (typeof window !== "undefined" && window.location && window.location.pathname && window.location.pathname.indexOf("admin.html") !== -1) {
            return;
        }

        try {
            if (window.stop) {
                window.stop();
            }
        } catch (e) {}

        document.body.innerHTML = "";

        // Stylize a robust high-contrast lock block readable under low-refresh rate e-ink panels
        var head = document.getElementsByTagName("head")[0];
        var style = document.createElement("style");
        style.type = "text/css";
        style.innerHTML =
            "body { background-color: #ffffff !important; color: #000000 !important; font-family: 'Bookerly', 'Amazon Ember', 'Caecilia', serif !important; text-align: center !important; padding: 50px 20px !important; }\n" +
            ".gatekeeper-card { border: 5px solid #000000; padding: 40px 20px; max-width: 480px; margin: 60px auto; }\n" +
            "h1 { font-size: 26px; text-transform: uppercase; font-weight: bold; margin-bottom: 20px; }\n" +
            "p { font-size: 16px; line-height: 1.6; margin-bottom: 20px; }\n" +
            ".shield-icon { font-size: 64px; margin-bottom: 15px; }";
        
        if (head) {
            head.appendChild(style);
        }

        var blockCard = document.createElement("div");
        blockCard.className = "gatekeeper-card";
        blockCard.innerHTML =
            "<div class='shield-icon'>🔒</div>" +
            "<h1>Access Denied</h1>" +
            "<p>" + (alertMessage || "This physical device terminal has been restricted from accessing InkChat workspaces.") + "</p>";
        
        document.body.appendChild(blockCard);
        throw new Error("InkChat Device Lockout Policy Triggered.");
    }

    /**
     * Public Submission Moderation Interceptor Shield
     */
    window.InkModerationShield = {
        moderate: function (textInput, onSuccessCallback, onFailureCallback) {
            dispatchXhrPost(CONFIG.apiBase + CONFIG.moderateContentEndpoint, { text: textInput }, function (err, response) {
                if (err) {
                    alert("Network error. Could not reach content moderation services.");
                    if (onFailureCallback) onFailureCallback("network-error");
                    return;
                }

                if (response && response.flagged) {
                    alert("Content violation blocked: Your input contains language flagged by the safety engine.");
                    if (onFailureCallback) onFailureCallback("content-flagged");
                } else {
                    if (onSuccessCallback) onSuccessCallback();
                }
            });
        }
    };

    /**
     * Administrative Registration API
     */
    window.InkDeviceManager = {
        registerCurrentDevice: function (userId, callback) {
            syncLocalStorageAndCookie(function (token, err) {
                if (err) {
                    if (callback) callback(err, null);
                    return;
                }
                dispatchXhrPost(CONFIG.apiBase + CONFIG.registerDeviceEndpoint, {
                    fingerprint: token,
                    userId: userId
                }, callback);
            });
        }
    };

    /**
     * Core Messaging Transmission & Pull API
     * Written strictly in ES5 JavaScript using raw XHR protocols.
     */
    window.InkChatEngine = {
        login: function (username, password, fingerprint, callback) {
            var payload = {
                username: username,
                password: password,
                fingerprint: fingerprint
            };
            dispatchXhrPost(CONFIG.apiBase + "/api/login", payload, callback);
        },
        register: function (username, password, fingerprint, callback) {
            var payload = {
                username: username,
                password: password,
                fingerprint: fingerprint
            };
            dispatchXhrPost(CONFIG.apiBase + "/api/register", payload, callback);
        },
        sendMessage: function (text, sessionToken, fingerprint, callback) {
            var payload = {
                text: text,
                sessionToken: sessionToken,
                fingerprint: fingerprint
            };
            dispatchXhrPost(CONFIG.apiBase + "/api/send-message", payload, callback);
        },
        getMessages: function (callback) {
            var xhr = null;
            if (window.XMLHttpRequest) {
                xhr = new XMLHttpRequest();
            } else if (window.ActiveXObject) {
                try {
                    xhr = new ActiveXObject("Msxml2.XMLHTTP");
                } catch (e) {
                    try {
                        xhr = new ActiveXObject("Microsoft.XMLHTTP");
                    } catch (el) {}
                }
            }

            if (!xhr) {
                callback(new Error("Browser does not support XHR protocols."), null);
                return;
            }

            // Perform standard asynchronous GET query
            xhr.open("GET", CONFIG.apiBase + "/api/get-messages", true);
            
            xhr.onreadystatechange = function () {
                if (xhr.readyState === 4) {
                    if (xhr.status >= 200 && xhr.status < 300) {
                        var parsedResponse = null;
                        try {
                            parsedResponse = JSON.parse(xhr.responseText);
                        } catch (e) {
                            parsedResponse = xhr.responseText;
                        }
                        callback(null, parsedResponse);
                    } else {
                        callback(new Error("Message retrieval failed with HTTP " + xhr.status), null);
                    }
                }
            };

            xhr.send(null);
        }
    };

    /**
     * Self-executing Load Routing Hook
     */
    function executeTelemetrySync() {
        // Telemetry Isolation: Completely disable telemetry for the admin panel page
        if (typeof window !== "undefined" && window.location && window.location.pathname && window.location.pathname.indexOf("admin.html") !== -1) {
            return;
        }

        // Cryptographic session token cookie linkage inside initial hardware handshake payload
        CONFIG.currentUserId = readCookie("inkchat_session_token");

        syncLocalStorageAndCookie(function (token, err) {
            if (err === "DESKTOP_SPOOF_DETECTED") {
                enforceDeviceLockout("Enforcing hardware policy: Direct desktop client spoofing is strictly prohibited.");
                return;
            }

            if (!token) {
                enforceDeviceLockout("Failed to compile secure, stateless machine signatures.");
                return;
            }

            // Handshake verification with Cloudflare Worker security proxy
            dispatchXhrPost(CONFIG.apiBase + CONFIG.checkHardwareEndpoint, {
                fingerprint: token,
                currentUserId: CONFIG.currentUserId
            }, function (handshakeErr, response) {
                if (handshakeErr) {
                    if (handshakeErr.status === 403) {
                        enforceDeviceLockout(handshakeErr.message || "This physical hardware terminal has been banned permanently due to content violations.");
                    } else {
                        enforceDeviceLockout("Handshake Gateway Failure. The security verification server could not be resolved.");
                    }
                    return;
                }

                if (response) {
                    if (response.status === "BANNED") {
                        enforceDeviceLockout(response.message || "This physical hardware terminal has been banned permanently due to content violations.");
                    } else if (response.status === "DENIED") {
                        enforceDeviceLockout(response.message || "Enforcing policy: Only one account allowed per physical device.");
                    } else if (response.status === "ALLOWED") {
                        // Handshake passed, expose validated token to app environment
                        window.InkDeviceFingerprint = token;
                        
                        if (typeof window.dispatchEvent === "function" && typeof window.CustomEvent === "function") {
                            var inkReadyEvent = new CustomEvent("inkDeviceReady", { detail: { fingerprint: token } });
                            window.dispatchEvent(inkReadyEvent);
                        }
                    }
                } else {
                    enforceDeviceLockout("Handshake response payload corrupted.");
                }
            });
        });
    }

    // Attach load listener safely using legacy bindings
    if (window.addEventListener) {
        window.addEventListener("load", executeTelemetrySync, false);
    } else if (window.attachEvent) {
        window.attachEvent("onload", executeTelemetrySync);
    } else {
        window.onload = executeTelemetrySync;
    }
})();
