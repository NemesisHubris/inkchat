/* app.js — InkChat main application (ES5) */
(function (window, doc) {
    'use strict';

    // ── State ─────────────────────────────────────────────────────────────
    var S = {
        userId:    null,   // username string
        token:     null,   // session token
        deviceId:  null,
        authMode:  'login',
        reply:     null,   // { userId, timestamp, text }
        sending:   false,
        seenTs:    {},     // timestamp -> true (tracks what's rendered)
        inbox:     [],     // { userId, timestamp, text, replyTo }
        dismissed: {},     // timestamp -> true
        ws:        null,
        pollTimer: null
    };

    // ── DOM helpers ───────────────────────────────────────────────────────
    function el(id)   { return doc.getElementById(id); }
    function cls(id)  { return el(id).classList; }

    function show(id)  { cls(id).add('visible'); }
    function hide(id)  { cls(id).remove('visible'); }
    function vis(id)   { return cls(id).contains('visible'); }

    function esc(s) {
        var d = doc.createElement('div');
        d.textContent = String(s || '');
        return d.innerHTML;
    }

    var _noticeTimer = null;
    function toast(msg) {
        var n = el('notice');
        n.textContent = msg;
        n.style.display = 'block';
        if (_noticeTimer) clearTimeout(_noticeTimer);
        _noticeTimer = setTimeout(function () { n.style.display = 'none'; }, 3000);
    }

    function maskedName(u) {
        if (!u || u.length <= 6) return u;
        return u.slice(0, 5) + '***' + u.slice(-2);
    }

    function fmtTime(ts) {
        return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }

    function atBottom(box) {
        return box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    }

    function scrollDown(box) {
        box.scrollTop = box.scrollHeight;
    }

    // ── Auth ──────────────────────────────────────────────────────────────
    function switchTab(mode) {
        S.authMode = mode;
        el('tab-login').classList.toggle('active', mode === 'login');
        el('tab-reg').classList.toggle('active',   mode === 'register');
        el('auth-btn').textContent = mode === 'login' ? 'Log In' : 'Register';
        el('tos-row').classList.toggle('visible', mode === 'register');
        hide('auth-err');
    }

    function submitAuth(e) {
        if (e && e.preventDefault) e.preventDefault();

        var username = el('f-user').value.trim();
        var password = el('f-pass').value;

        hide('auth-err');

        if (!username || !password) return false;

        if (username !== username.replace(/[^a-zA-Z0-9_]/g, '')) {
            showAuthErr('Username must be alphanumeric only.');
            return false;
        }

        if (S.authMode === 'register' && !el('tos-check').checked) {
            showAuthErr('You must accept the Terms of Use.');
            return false;
        }

        var btn = el('auth-btn');
        btn.disabled = true;
        btn.textContent = '…';

        var deviceId = window.InkDeviceId || localStorage.getItem('ink_device_id');

        function done(err, res) {
            btn.disabled = false;
            btn.textContent = S.authMode === 'login' ? 'Log In' : 'Register';

            if (err || !res || res.status !== 'SUCCESS') {
                showAuthErr((err && err.message) || (res && res.message) || 'Something went wrong.');
                return;
            }

            S.userId = res.username;
            S.token  = res.token || null;
            try {
                if (res.token)         localStorage.setItem('inkchat_session_token', res.token);
                if (res.ink_device_id) localStorage.setItem('ink_device_id', res.ink_device_id);
                if (S.authMode === 'register') localStorage.setItem('inkchat_registered', 'true');
            } catch (ex) {}

            hide('auth-screen');
            launchChat();
        }

        if (S.authMode === 'login') {
            window.InkAPI.login(username, password, deviceId, done);
        } else {
            window.InkAPI.register(username, password, deviceId, done);
        }

        return false;
    }

    function showAuthErr(msg) {
        el('auth-err').textContent = msg;
        show('auth-err');
    }

    function restoreSession(cb) {
        var stored = null;
        try { stored = localStorage.getItem('inkchat_session_token'); } catch (e) {}
        window.InkAPI.getSession(stored, function (err, res) {
            if (!err && res && res.authenticated && res.username) {
                S.userId = res.username;
                S.token  = res.token || stored;
                try {
                    if (res.token)         localStorage.setItem('inkchat_session_token', res.token);
                    if (res.ink_device_id) localStorage.setItem('ink_device_id', res.ink_device_id);
                } catch (ex) {}
                cb(true);
            } else {
                cb(false);
            }
        });
    }

    // ── Chat workspace ────────────────────────────────────────────────────
    function launchChat() {
        S.seenTs    = {};
        S.inbox     = [];
        S.dismissed = {};

        el('app').classList.add('visible');
        el('user-label').textContent = '@' + S.userId;
        el('msg-input').disabled = false;
        el('send-btn').disabled  = false;
        el('msg-input').focus();

        el('msg-input').onkeydown = function (e) {
            var enterSend = localStorage.getItem('setting_enter_to_send') !== 'false';
            if (e.keyCode === 13 && !e.shiftKey && enterSend) {
                e.preventDefault();
                submitSend(null);
            }
        };

        el('setting-enter').checked = localStorage.getItem('setting_enter_to_send') !== 'false';

        if (localStorage.getItem('inkchat_rules_accepted') !== 'true') {
            appendSystem('Rules: be respectful · no spam · no ads. Violations = ban.');
            try { localStorage.setItem('inkchat_rules_accepted', 'true'); } catch (ex) {}
        }

        appendSystem('Connected as @' + S.userId + '. Welcome to InkChat.');
        fetchAndRender();
        connectWS();
    }

    // ── Message rendering — append-only ───────────────────────────────────
    function appendSystem(text) {
        var box = el('messages');
        var d = doc.createElement('div');
        d.className = 'msg msg-system';
        d.textContent = text;
        box.appendChild(d);
        scrollDown(box);
    }

    function buildBubble(m) {
        var myMask = maskedName(S.userId);
        var isOut  = m.userId === myMask;
        var isAdm  = m.role === 'admin';

        var bubble = doc.createElement('div');
        bubble.id  = 'msg-' + m.timestamp;
        bubble.className = 'msg ' + (isAdm ? 'msg-admin' : isOut ? 'msg-out' : 'msg-in');

        // Quote block (reply preview)
        if (m.replyTo) {
            var q = doc.createElement('div');
            q.className = 'quote';
            q.title = 'Jump to original';
            q.textContent = '@' + m.replyTo.userId + ': ' +
                (m.replyTo.text.length > 60 ? m.replyTo.text.slice(0, 60) + '…' : m.replyTo.text);
            (function (ts) {
                q.onclick = function () { jumpTo(ts); };
            })(m.replyTo.timestamp);
            bubble.appendChild(q);
        }

        // Meta row
        var meta = doc.createElement('div');
        meta.className = 'msg-meta';

        if (isAdm) {
            var badge = doc.createElement('span');
            badge.className = 'dev-badge';
            badge.textContent = 'DEV';
            meta.appendChild(badge);
        }

        var name = doc.createElement('span');
        name.className = 'msg-name';
        name.textContent = m.userId;
        meta.appendChild(name);

        var rb = doc.createElement('button');
        rb.className = 'reply-btn';
        rb.textContent = 'Reply';
        (function (msg) { rb.onclick = function () { setReply(msg); }; })(m);
        meta.appendChild(rb);

        var t = doc.createElement('span');
        t.className = 'msg-time';
        t.textContent = fmtTime(m.timestamp);
        meta.appendChild(t);

        bubble.appendChild(meta);

        var txt = doc.createElement('div');
        txt.className = 'msg-text';
        txt.textContent = m.text;
        bubble.appendChild(txt);

        return bubble;
    }

    function renderMessages(rawList) {
        var box   = el('messages');
        var wasLow = atBottom(box);
        var chron = rawList.slice().reverse(); // oldest first
        var added = false;

        for (var i = 0; i < chron.length; i++) {
            var m = null;
            try { m = JSON.parse(chron[i]); } catch (e) { continue; }
            if (!m || !m.timestamp) continue;
            if (S.seenTs[m.timestamp]) continue;

            S.seenTs[m.timestamp] = true;
            box.appendChild(buildBubble(m));
            checkInbox(m);
            added = true;
        }

        if (added && wasLow) scrollDown(box);
    }

    function jumpTo(ts) {
        var target = doc.getElementById('msg-' + ts);
        if (!target) { toast('Message not in view.'); return; }
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        target.style.outline = '3px solid #000';
        setTimeout(function () { target.style.outline = ''; }, 1200);
    }

    // ── Inbox ─────────────────────────────────────────────────────────────
    function checkInbox(m) {
        if (!S.userId) return;
        if (m.userId === maskedName(S.userId)) return; // own message
        if (S.dismissed[m.timestamp]) return;

        var myMask      = maskedName(S.userId);
        var isReplyToMe = m.replyTo && (m.replyTo.userId === S.userId || m.replyTo.userId === myMask);
        var isMentioned = m.text.toLowerCase().indexOf('@' + S.userId.toLowerCase()) !== -1;
        if (!isReplyToMe && !isMentioned) return;

        for (var j = 0; j < S.inbox.length; j++) {
            if (S.inbox[j].timestamp === m.timestamp) return;
        }
        S.inbox.push(m);
        el('inbox-btn').textContent = 'Inbox (' + S.inbox.length + ')';
    }

    // ── Send ──────────────────────────────────────────────────────────────
    function submitSend(e) {
        if (e && e.preventDefault) e.preventDefault();

        var input = el('msg-input');
        var text  = input.value.trim();
        if (!text || S.sending) return false;

        var pendingReply = S.reply;

        S.sending = true;
        input.value = '';
        hide('send-error');
        cancelReply();

        // Optimistic bubble
        var tempId = 'opt-' + Date.now();
        var myLabel = maskedName(S.userId) || S.userId;
        var opt = doc.createElement('div');
        opt.id = tempId;
        opt.className = 'msg msg-out msg-pending';
        opt.innerHTML =
            '<div class="msg-meta"><span class="msg-name">' + esc(myLabel) + '</span>' +
            '<span class="msg-time">sending…</span></div>' +
            '<div class="msg-text">' + esc(text) + '</div>';
        var box = el('messages');
        box.appendChild(opt);
        scrollDown(box);

        var deviceId = localStorage.getItem('ink_device_id') || window.InkDeviceId;

        function fail(msg) {
            S.sending = false;
            var o = doc.getElementById(tempId);
            if (o) o.parentNode.removeChild(o);
            input.value = text;
            if (pendingReply) setReply(pendingReply);
            showSendErr(msg);
        }

        var timer = setTimeout(function () {
            if (S.sending) fail('Send timed out. Try again.');
        }, 7000);

        window.InkAPI.sendMessage(text, S.token, deviceId, pendingReply, function (err, res) {
            clearTimeout(timer);

            if (err) {
                fail(err.status === 429 ? 'Slow down — wait a moment.' :
                     err.status === 409 ? 'Already sent — type something new.' :
                     err.message || 'Send failed.');
                return;
            }
            if (res && res.status === 'ERROR') {
                fail(res.message || 'Message blocked.');
                return;
            }

            S.sending = false;
            var o = doc.getElementById(tempId);
            if (o) o.parentNode.removeChild(o);
            fetchAndRender();
            input.focus();
        });

        return false;
    }

    function showSendErr(msg) {
        el('send-error').textContent = msg;
        show('send-error');
        setTimeout(function () { hide('send-error'); }, 4000);
    }

    // ── Reply ─────────────────────────────────────────────────────────────
    function setReply(m) {
        S.reply = { userId: m.userId, timestamp: m.timestamp, text: m.text };
        el('reply-text').textContent =
            'Replying to @' + m.userId + ': ' +
            (m.text.length > 55 ? m.text.slice(0, 55) + '…' : m.text);
        show('reply-bar');
        el('msg-input').focus();
    }

    function cancelReply() {
        S.reply = null;
        hide('reply-bar');
    }

    // ── Polling fallback ──────────────────────────────────────────────────
    function fetchAndRender() {
        window.InkAPI.getMessages(function (err, msgs) {
            if (!err && Array.isArray(msgs)) renderMessages(msgs);
        });
    }

    function startPoll() {
        if (!S.pollTimer) S.pollTimer = setInterval(fetchAndRender, 5000);
    }

    function stopPoll() {
        if (S.pollTimer) { clearInterval(S.pollTimer); S.pollTimer = null; }
    }

    // ── WebSocket ─────────────────────────────────────────────────────────
    function connectWS() {
        if (!window.WebSocket) { startPoll(); return; }
        if (S.ws && (S.ws.readyState === 0 || S.ws.readyState === 1)) return;

        var ws;
        try { ws = new WebSocket(window.InkAPI.wsBase + '/ws'); }
        catch (ex) { startPoll(); return; }

        S.ws = ws;

        ws.onopen = function () {
            stopPoll();
            setStatus(true, 'Live');
        };
        ws.onmessage = function () {
            fetchAndRender();
        };
        ws.onclose = function () {
            S.ws = null;
            setStatus(false, 'Reconnecting…');
            if (S.userId) {
                startPoll();
                setTimeout(connectWS, 4000);
            }
        };
        ws.onerror = function () {};
    }

    function setStatus(live, text) {
        el('status-dot').classList.toggle('live', live);
        el('status-text').textContent = text;
    }

    // ── Sign out ──────────────────────────────────────────────────────────
    function signOut() {
        stopPoll();
        if (S.ws) { try { S.ws.close(); } catch (e) {} S.ws = null; }
        try { localStorage.removeItem('inkchat_session_token'); } catch (e) {}
        window.InkAPI.logout(S.token, function () { window.location.reload(); });
    }

    // ── Modals ────────────────────────────────────────────────────────────
    function openTos(e) { if (e) e.preventDefault(); show('tos-modal'); return false; }
    function closeTos()  { hide('tos-modal'); }

    function openInbox() {
        var body = el('inbox-body');
        body.innerHTML = '';

        if (S.inbox.length === 0) {
            body.innerHTML = '<p style="text-align:center;padding:30px;font-style:italic;color:#666;">No new mentions or replies.</p>';
            show('inbox-modal');
            return;
        }

        var clearWrap = doc.createElement('div');
        clearWrap.style.cssText = 'text-align:right;margin-bottom:10px;';
        var clearBtn = doc.createElement('button');
        clearBtn.className = 'btn btn-sm';
        clearBtn.textContent = 'Clear All';
        clearBtn.onclick = function () {
            for (var i = 0; i < S.inbox.length; i++) S.dismissed[S.inbox[i].timestamp] = true;
            S.inbox = [];
            el('inbox-btn').textContent = 'Inbox (0)';
            closeInbox();
        };
        clearWrap.appendChild(clearBtn);
        body.appendChild(clearWrap);

        for (var i = 0; i < S.inbox.length; i++) {
            (function (m) {
                var myMask = maskedName(S.userId);
                var isRep  = m.replyTo && (m.replyTo.userId === S.userId || m.replyTo.userId === myMask);
                var tag    = isRep ? 'REPLY' : 'MENTION';

                var item = doc.createElement('div');
                item.style.cssText = 'border:2px solid #000;padding:11px;margin-bottom:10px;background:#fff;box-shadow:2px 2px 0 #ccc;';
                item.innerHTML =
                    '<div style="font-size:11px;color:#555;margin-bottom:5px;">' +
                        '<strong style="background:#000;color:#fff;padding:1px 5px;font-size:10px;margin-right:5px;">' + tag + '</strong>' +
                        'from @' + esc(m.userId) +
                    '</div>' +
                    '<div style="font-size:13px;font-weight:bold;margin-bottom:8px;">' + esc(m.text) + '</div>';

                var btns = doc.createElement('div');
                btns.style.cssText = 'text-align:right;display:flex;gap:6px;justify-content:flex-end;';

                var dismissBtn = doc.createElement('button');
                dismissBtn.className = 'btn btn-sm';
                dismissBtn.textContent = 'Dismiss';
                dismissBtn.onclick = function () {
                    S.dismissed[m.timestamp] = true;
                    S.inbox = S.inbox.filter(function (x) { return x.timestamp !== m.timestamp; });
                    el('inbox-btn').textContent = 'Inbox (' + S.inbox.length + ')';
                    closeInbox();
                    openInbox();
                };

                var focusBtn = doc.createElement('button');
                focusBtn.className = 'btn btn-sm';
                focusBtn.textContent = 'Focus';
                focusBtn.onclick = function () { closeInbox(); jumpTo(m.timestamp); };

                btns.appendChild(dismissBtn);
                btns.appendChild(focusBtn);
                item.appendChild(btns);
                body.appendChild(item);
            })(S.inbox[i]);
        }

        show('inbox-modal');
    }

    function closeInbox() { hide('inbox-modal'); }

    function openSettings() {
        el('setting-enter').checked = localStorage.getItem('setting_enter_to_send') !== 'false';
        show('settings-modal');
    }
    function closeSettings() { hide('settings-modal'); }

    function saveSettings() {
        try { localStorage.setItem('setting_enter_to_send', el('setting-enter').checked ? 'true' : 'false'); } catch (e) {}
        closeSettings();
        toast('Settings saved.');
    }

    function togglePwForm() {
        var f = el('pw-form');
        var b = el('pw-toggle');
        if (f.style.display === 'none') {
            f.style.display = 'block';
            b.textContent = 'Cancel';
        } else {
            f.style.display = 'none';
            b.textContent = 'Change Password';
            el('pw-old').value = el('pw-new').value = el('pw-confirm').value = '';
            el('pw-status').style.display = 'none';
        }
    }

    function submitPwChange() {
        var old = el('pw-old').value, nw = el('pw-new').value, cf = el('pw-confirm').value;
        var st  = el('pw-status');
        st.style.display = 'none';

        if (!old || !nw || !cf)     { setPwStatus('Fill in all fields.',       'red'); return; }
        if (nw !== cf)              { setPwStatus('Passwords do not match.',    'red'); return; }
        if (nw.length < 4)          { setPwStatus('Minimum 4 characters.',      'red'); return; }

        window.InkAPI.changePassword(old, nw, S.token, function (err, res) {
            if (err || !res || res.status !== 'SUCCESS') {
                setPwStatus((err && err.message) || (res && res.message) || 'Failed.', 'red');
            } else {
                S.token = res.token || S.token;
                try { localStorage.setItem('inkchat_session_token', S.token); } catch (e) {}
                setPwStatus('Password changed!', 'green');
                setTimeout(togglePwForm, 2000);
            }
        });
    }

    function setPwStatus(msg, color) {
        var st = el('pw-status');
        st.textContent = msg;
        st.style.cssText = 'display:block;font-size:11px;font-weight:bold;text-align:center;margin-top:8px;color:' + color + ';';
    }

    // ── Boot ──────────────────────────────────────────────────────────────
    function onInkReady() {
        S.deviceId = window.InkDeviceId;

        restoreSession(function (ok) {
            if (ok) {
                launchChat();
            } else {
                // Hide register tab if user has registered before
                if (localStorage.getItem('inkchat_registered') === 'true') {
                    el('tab-reg').style.display = 'none';
                }
                show('auth-screen');
            }
        });
    }

    if (window.addEventListener) {
        window.addEventListener('inkReady', onInkReady, false);
    }
    // Fallback: if load event already fired before script ran
    if (window.InkDeviceId && !S.userId) onInkReady();

    // ── Expose to HTML inline handlers ────────────────────────────────────
    window.switchTab      = switchTab;
    window.submitAuth     = submitAuth;
    window.submitSend     = submitSend;
    window.cancelReply    = cancelReply;
    window.signOut        = signOut;
    window.openTos        = openTos;
    window.closeTos       = closeTos;
    window.openInbox      = openInbox;
    window.closeInbox     = closeInbox;
    window.openSettings   = openSettings;
    window.closeSettings  = closeSettings;
    window.saveSettings   = saveSettings;
    window.togglePwForm   = togglePwForm;
    window.submitPwChange = submitPwChange;

}(window, document));
