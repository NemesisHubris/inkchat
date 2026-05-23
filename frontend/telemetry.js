/* telemetry.js — device identity + API client (ES5) */
(function (window) {
    'use strict';

    var isLocal = (
        window.location.hostname === 'localhost' ||
        window.location.hostname === '127.0.0.1' ||
        window.location.protocol === 'file:'
    );
    var localHost = window.location.hostname === '127.0.0.1' ? '127.0.0.1' : 'localhost';

    var API  = isLocal ? ('http://' + localHost + ':8787') : 'https://slatechat-proxy.kindlemodshelf.workers.dev';
    var WS   = isLocal ? ('ws://'  + localHost + ':8787') : 'wss://slatechat-proxy.kindlemodshelf.workers.dev';
    var DKEY = 'ink_device_id';

    // ── UUID cookie ──────────────────────────────────────────────────────

    function makeUUID() {
        if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
            var r = Math.random() * 16 | 0;
            return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
        });
    }

    function setCookie(name, val) {
        var exp = new Date();
        exp.setFullYear(exp.getFullYear() + 10);
        document.cookie = name + '=' + encodeURIComponent(val) +
            '; expires=' + exp.toUTCString() + '; path=/; SameSite=Strict';
    }

    function getCookie(name) {
        var pfx = name + '=', parts = document.cookie.split(';');
        for (var i = 0; i < parts.length; i++) {
            var p = parts[i].trim();
            if (p.indexOf(pfx) === 0) return decodeURIComponent(p.slice(pfx.length));
        }
        return null;
    }

    function getOrCreateDeviceId() {
        var id = null;
        try { id = localStorage.getItem(DKEY); } catch (e) {}
        if (!id) id = getCookie(DKEY);
        if (!id) id = makeUUID();
        setCookie(DKEY, id);
        try { localStorage.setItem(DKEY, id); } catch (e) {}
        return id;
    }

    // ── Hardware fingerprint — deterministic, survives cookie clears ─────
    // Collects stable browser + hardware signals and hashes with FNV-1a.

    function fingerprint() {
        var p = [
            's:'   + screen.width + 'x' + screen.height + 'x' + screen.colorDepth,
            'dpr:' + (window.devicePixelRatio || 1),
            'plt:' + (navigator.platform || ''),
            'lng:' + (navigator.language  || ''),
            'tz:'  + new Date().getTimezoneOffset(),
            'cpu:' + (navigator.hardwareConcurrency || 0),
            'mem:' + (navigator.deviceMemory        || 0),
            'tp:'  + (navigator.maxTouchPoints      || 0)
        ];

        try { p.push('tzn:' + Intl.DateTimeFormat().resolvedOptions().timeZone); } catch (e) {}

        // Canvas: reflects OS font rendering + GPU compositing pipeline
        try {
            var c = document.createElement('canvas');
            var x = c.getContext('2d');
            if (x) {
                c.width = 200; c.height = 40;
                x.textBaseline = 'top';
                x.font         = '14px Arial';
                x.fillStyle    = '#f60';
                x.fillRect(125, 1, 62, 20);
                x.fillStyle = '#069';
                x.fillText('InkChat♥', 2, 15);
                x.fillStyle = 'rgba(102,204,0,0.7)';
                x.fillText('InkChat♥', 4, 17);
                p.push('cv:' + c.toDataURL().slice(-50));
            }
        } catch (e) {}

        // WebGL: identifies GPU model
        try {
            var gc = document.createElement('canvas');
            var gl = gc.getContext('webgl') || gc.getContext('experimental-webgl');
            if (gl) {
                var d = gl.getExtension('WEBGL_debug_renderer_info');
                if (d) {
                    p.push('gl:' + (gl.getParameter(d.UNMASKED_RENDERER_WEBGL) || '') +
                           '|'  + (gl.getParameter(d.UNMASKED_VENDOR_WEBGL)   || ''));
                }
            }
        } catch (e) {}

        // FNV-1a 32-bit hash
        var raw = p.join('||'), h = 2166136261;
        for (var i = 0; i < raw.length; i++) {
            h ^= raw.charCodeAt(i);
            h  = (h * 16777619) >>> 0;
        }
        return h.toString(16);
    }

    // ── XHR helpers ──────────────────────────────────────────────────────

    function post(path, body, cb) {
        var xhr = new XMLHttpRequest();
        xhr.open('POST', API + path, true);
        xhr.withCredentials = true;
        xhr.setRequestHeader('Content-Type', 'application/json;charset=UTF-8');
        xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4) return;
            if (xhr.status >= 200 && xhr.status < 300) {
                var d = null; try { d = JSON.parse(xhr.responseText); } catch (e) { d = xhr.responseText; }
                cb(null, d);
            } else {
                var obj = null; try { obj = JSON.parse(xhr.responseText); } catch (e) {}
                var msg = (obj && obj.message) ? obj.message
                        : xhr.status === 0 ? 'Network error'
                        : xhr.statusText || 'Request failed';
                var err = new Error(msg); err.status = xhr.status; cb(err, null);
            }
        };
        xhr.send(JSON.stringify(body));
    }

    function get(path, cb) {
        var xhr = new XMLHttpRequest();
        xhr.open('GET', API + path, true);
        xhr.withCredentials = true;
        xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4) return;
            if (xhr.status >= 200 && xhr.status < 300) {
                var d = null; try { d = JSON.parse(xhr.responseText); } catch (e) { d = xhr.responseText; }
                cb(null, d);
            } else {
                cb(new Error('HTTP ' + xhr.status), null);
            }
        };
        xhr.send(null);
    }

    // ── Public API ────────────────────────────────────────────────────────

    window.InkAPI = {
        wsBase: WS,

        login: function (username, password, deviceId, cb) {
            post('/api/login', {
                username:             username,
                password:             password,
                ink_device_id:        deviceId,
                hardware_fingerprint: window.InkFingerprint || null
            }, cb);
        },

        register: function (username, password, deviceId, cb) {
            post('/api/register', {
                username:             username,
                password:             password,
                ink_device_id:        deviceId,
                hardware_fingerprint: window.InkFingerprint || null
            }, cb);
        },

        sendMessage: function (text, token, deviceId, replyTo, cb) {
            post('/api/send-message', {
                text:          text,
                sessionToken:  token,
                ink_device_id: deviceId,
                replyTo:       replyTo || null
            }, cb);
        },

        getMessages: function (cb) {
            get('/api/get-messages', cb);
        },

        getSession: function (token, cb) {
            get('/api/session' + (token ? '?token=' + encodeURIComponent(token) : ''), cb);
        },

        logout: function (token, cb) {
            post('/api/logout', { sessionToken: token, allSessions: true }, cb || function () {});
        },

        changePassword: function (oldPw, newPw, token, cb) {
            post('/api/change-password', { oldPassword: oldPw, newPassword: newPw, sessionToken: token }, cb);
        }
    };

    // ── Boot ─────────────────────────────────────────────────────────────

    function init() {
        if (window.location.pathname.indexOf('admin.html') !== -1) return;

        var deviceId = getOrCreateDeviceId();
        var fp       = fingerprint();

        window.InkDeviceId  = deviceId;
        window.InkFingerprint = fp;

        if (typeof window.CustomEvent === 'function') {
            window.dispatchEvent(new CustomEvent('inkReady', {
                detail: { deviceId: deviceId, fingerprint: fp }
            }));
        }
    }

    if (window.addEventListener) {
        window.addEventListener('load', init, false);
    } else {
        window.onload = init;
    }

}(window));
