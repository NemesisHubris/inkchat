/* app.js — InkChat main application (ES5) */
(function (window, doc) {
    'use strict';

    // ── State ─────────────────────────────────────────────────────────────
    var S = {
        userId:            null,
        token:             null,
        deviceId:          null,
        authMode:          'login',
        reply:             null,
        sending:           false,
        seenTs:            {},
        inbox:             [],
        dismissed:         {},
        ws:                null,
        pollTimer:         null,
        emojiOpen:         false,
        view:              'general',   // 'general' | 'topics-list' | 'topic-chat'
        currentTopic:      null,        // {id, name} when in topic-chat
        topicsSearchTimer: null
    };

    var EMOJIS = [
        '😊','🙂','😀','😄','😂','😅','😭','😤','😴','🤔',
        '😎','😬','😏','😡','🥳','🫡','🤦','🤷','🙃','😶',
        '👍','👎','👋','🤝','🙏','👏','❤️','🔥','⭐','🎉',
        '✅','❌','❓','❗','💬','📌','🎊','💡','🫠','💀'
    ];

    // ── DOM helpers ───────────────────────────────────────────────────────
    function el(id) { return doc.getElementById(id); }
    function show(id) { el(id).classList.add('visible'); }
    function hide(id) { el(id).classList.remove('visible'); }

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
        _noticeTimer = setTimeout(function () { n.style.display = 'none'; }, 2800);
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

    function clearMessages() {
        el('messages').innerHTML = '';
        S.seenTs = {};
    }

    // ── Emoji picker ──────────────────────────────────────────────────────
    function buildEmojiPicker() {
        var picker = doc.createElement('div');
        picker.id = 'emoji-picker';
        for (var i = 0; i < EMOJIS.length; i++) {
            (function (em) {
                var btn = doc.createElement('button');
                btn.className   = 'emoji-btn';
                btn.textContent = em;
                btn.type        = 'button';
                btn.onclick     = function () { insertEmoji(em); };
                picker.appendChild(btn);
            })(EMOJIS[i]);
        }
        return picker;
    }

    function toggleEmojiPicker() {
        S.emojiOpen = !S.emojiOpen;
        el('emoji-picker').style.display = S.emojiOpen ? 'grid' : 'none';
        el('emoji-toggle').textContent   = S.emojiOpen ? '✕' : '☺';
    }

    function closeEmojiPicker() {
        if (!S.emojiOpen) return;
        S.emojiOpen = false;
        el('emoji-picker').style.display = 'none';
        el('emoji-toggle').textContent   = '☺';
    }

    function insertEmoji(em) {
        var input = el('msg-input');
        var s = input.selectionStart, e2 = input.selectionEnd;
        input.value = input.value.slice(0, s) + em + input.value.slice(e2);
        input.selectionStart = input.selectionEnd = s + em.length;
        input.focus();
        closeEmojiPicker();
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

        if (!/^[a-zA-Z0-9_]+$/.test(username)) {
            showAuthErr('Username: letters, numbers, underscores only.');
            return false;
        }

        if (S.authMode === 'register' && !el('tos-check').checked) {
            showAuthErr('You must accept the Terms of Use.');
            return false;
        }

        var btn = el('auth-btn');
        btn.disabled    = true;
        btn.textContent = '…';

        var deviceId = window.InkDeviceId || localStorage.getItem('ink_device_id');

        function done(err, res) {
            btn.disabled    = false;
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

    // ── View switching ─────────────────────────────────────────────────────
    function switchView(v) {
        S.view = v;
        var inList = (v === 'topics-list');
        var inTopic = (v === 'topic-chat');

        el('tab-general').classList.toggle('active', v === 'general');
        el('tab-topics').classList.toggle('active',  inList || inTopic);

        el('topics-view').style.display = inList   ? 'flex' : 'none';
        el('messages').style.display    = inList   ? 'none' : '';
        el('input-area').style.display  = inList   ? 'none' : '';
        el('topic-bar').style.display   = inTopic  ? 'flex' : 'none';

        closeEmojiPicker();

        if (inList) {
            var q = el('topics-search') ? el('topics-search').value : '';
            loadTopics(q);
        } else if (v === 'general') {
            S.currentTopic = null;
            clearMessages();
            el('msg-input').placeholder = 'Type a message…';
            fetchAndRender();
        }
    }

    // ── Topics list ────────────────────────────────────────────────────────
    function loadTopics(q) {
        var listEl = el('topics-list');
        if (!listEl) return;
        listEl.innerHTML = '<div class="topic-empty">Loading…</div>';

        window.InkAPI.getTopics(q || '', function (err, list) {
            if (err || !Array.isArray(list)) {
                listEl.innerHTML = '<div class="topic-empty">Could not load topics.</div>';
                return;
            }
            renderTopicsList(list);
        });
    }

    function renderTopicsList(list) {
        var listEl = el('topics-list');
        listEl.innerHTML = '';

        if (!list.length) {
            listEl.innerHTML = '<div class="topic-empty">No topics yet. Be the first to create one!</div>';
            return;
        }

        for (var i = 0; i < list.length; i++) {
            (function (topic) {
                var row = doc.createElement('div');
                row.className = 'topic-item';
                row.innerHTML =
                    '<div class="topic-item-name">' + esc(topic.name) + '</div>' +
                    '<div class="topic-item-meta">by @' + esc(topic.creator) +
                    ' &middot; ' + topic.msg_count + ' message' + (topic.msg_count === 1 ? '' : 's') + '</div>';
                row.onclick = function () { openTopicChat(topic); };
                listEl.appendChild(row);
            })(list[i]);
        }
    }

    function topicsSearchChanged() {
        if (S.topicsSearchTimer) clearTimeout(S.topicsSearchTimer);
        var q = el('topics-search') ? el('topics-search').value : '';
        S.topicsSearchTimer = setTimeout(function () { loadTopics(q); }, 300);
    }

    function openTopicChat(topic) {
        S.currentTopic = topic;
        clearMessages();
        el('topic-bar-name').textContent = topic.name;
        el('msg-input').placeholder = '#' + topic.name;
        switchView('topic-chat');
        fetchAndRender();
        el('msg-input').focus();
    }

    function backToTopics() {
        S.currentTopic = null;
        clearMessages();
        switchView('topics-list');
    }

    // ── Create topic modal ─────────────────────────────────────────────────
    function openCreateTopic() {
        el('topic-name-input').value = '';
        hide('create-topic-err');
        el('create-topic-btn').disabled    = false;
        el('create-topic-btn').textContent = 'Create';
        show('create-topic-modal');
        el('topic-name-input').focus();
    }

    function closeCreateTopic() {
        hide('create-topic-modal');
    }

    function submitCreateTopic() {
        var name = el('topic-name-input').value.trim();
        hide('create-topic-err');

        if (!name) { showCreateTopicErr('Topic name is required.'); return; }

        var btn = el('create-topic-btn');
        btn.disabled    = true;
        btn.textContent = '…';

        var deviceId = localStorage.getItem('ink_device_id') || window.InkDeviceId;

        window.InkAPI.createTopic(name, S.token, deviceId, function (err, res) {
            btn.disabled    = false;
            btn.textContent = 'Create';

            if (err || !res || res.status !== 'SUCCESS') {
                showCreateTopicErr((err && err.message) || (res && res.message) || 'Failed to create topic.');
                return;
            }

            closeCreateTopic();
            toast('Topic created!');
            openTopicChat({ id: res.id, name: res.name });
        });
    }

    function showCreateTopicErr(msg) {
        el('create-topic-err').textContent = msg;
        show('create-topic-err');
    }

    // ── Chat workspace ─────────────────────────────────────────────────────
    function launchChat() {
        S.seenTs    = {};
        S.inbox     = [];
        S.dismissed = {};
        S.view      = 'general';

        el('app').classList.add('visible');
        el('user-label').textContent = '@' + S.userId;
        el('msg-input').disabled = false;
        el('send-btn').disabled  = false;
        el('msg-input').focus();

        // ensure view-tabs visible, topic-bar hidden
        el('topic-bar').style.display  = 'none';
        el('topics-view').style.display = 'none';

        el('msg-input').onkeydown = function (e) {
            closeEmojiPicker();
            var enterSend = localStorage.getItem('setting_enter_to_send') !== 'false';
            if (e.keyCode === 13 && !e.shiftKey && enterSend) {
                e.preventDefault();
                submitSend(null);
            }
        };

        el('setting-enter').checked = localStorage.getItem('setting_enter_to_send') !== 'false';

        if (localStorage.getItem('inkchat_rules_seen') !== 'true') {
            appendSystem('Be respectful · no spam. Violations = ban.');
            try { localStorage.setItem('inkchat_rules_seen', 'true'); } catch (ex) {}
        }

        appendSystem('Signed in as @' + S.userId);
        fetchAndRender();
        connectWS();
    }

    // ── Messages — append-only ─────────────────────────────────────────────
    function appendSystem(text) {
        var box = el('messages');
        var d   = doc.createElement('div');
        d.className   = 'msg msg-system';
        d.textContent = text;
        box.appendChild(d);
        scrollDown(box);
    }

    function buildBubble(m) {
        var isOut = (m.userId === S.userId);
        var isAdm = (m.role === 'admin');

        var bubble       = doc.createElement('div');
        bubble.id        = 'msg-' + m.timestamp;
        bubble.className = 'msg ' + (isAdm ? 'msg-admin' : isOut ? 'msg-out' : 'msg-in');

        if (m.replyTo) {
            var q       = doc.createElement('div');
            q.className = 'quote';
            q.title     = 'Jump to original';
            q.textContent = '@' + m.replyTo.userId + ': ' +
                (m.replyTo.text.length > 60 ? m.replyTo.text.slice(0, 60) + '…' : m.replyTo.text);
            (function (ts) { q.onclick = function () { jumpTo(ts); }; })(m.replyTo.timestamp);
            bubble.appendChild(q);
        }

        var meta       = doc.createElement('div');
        meta.className = 'msg-meta';

        if (isAdm) {
            var badge       = doc.createElement('span');
            badge.className   = 'dev-badge';
            badge.textContent = 'DEV';
            meta.appendChild(badge);
        }

        var name       = doc.createElement('span');
        name.className   = 'msg-name';
        name.textContent = m.userId;
        meta.appendChild(name);

        var rb       = doc.createElement('button');
        rb.className   = 'reply-btn';
        rb.textContent = '↩ Reply';
        (function (msg) { rb.onclick = function () { setReply(msg); }; })(m);
        meta.appendChild(rb);

        var t       = doc.createElement('span');
        t.className   = 'msg-time';
        t.textContent = fmtTime(m.timestamp);
        meta.appendChild(t);

        bubble.appendChild(meta);

        var txt       = doc.createElement('div');
        txt.className   = 'msg-text';
        txt.textContent = m.text;
        bubble.appendChild(txt);

        return bubble;
    }

    function renderMessages(rawList) {
        var box    = el('messages');
        var wasLow = atBottom(box);
        var chron  = rawList.slice().reverse();
        var added  = false;

        for (var i = 0; i < chron.length; i++) {
            var m = null;
            try { m = JSON.parse(chron[i]); } catch (e) { continue; }
            if (!m || !m.timestamp)    continue;
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
        if (!S.userId)                return;
        if (m.userId === S.userId)    return;
        if (S.dismissed[m.timestamp]) return;

        var uid         = S.userId.toLowerCase();
        var isReplyToMe = m.replyTo && (
            m.replyTo.userId === S.userId ||
            m.replyTo.userId.toLowerCase() === uid
        );
        var isMentioned = m.text.toLowerCase().indexOf('@' + uid) !== -1;
        if (!isReplyToMe && !isMentioned) return;

        for (var j = 0; j < S.inbox.length; j++) {
            if (S.inbox[j].timestamp === m.timestamp) return;
        }
        S.inbox.push(m);
        updateInboxBtn();
    }

    function updateInboxBtn() {
        el('inbox-btn').textContent = S.inbox.length > 0
            ? 'Inbox (' + S.inbox.length + ')'
            : 'Inbox';
    }

    // ── Send ──────────────────────────────────────────────────────────────
    function submitSend(e) {
        if (e && e.preventDefault) e.preventDefault();
        closeEmojiPicker();

        var input = el('msg-input');
        var text  = input.value.trim();
        if (!text || S.sending) return false;

        var pendingReply = S.reply;
        S.sending    = true;
        input.value  = '';
        hide('send-error');
        cancelReply();

        var tempId    = 'opt-' + Date.now();
        var opt       = doc.createElement('div');
        opt.id        = tempId;
        opt.className = 'msg msg-out msg-pending';
        opt.innerHTML =
            '<div class="msg-meta"><span class="msg-name">' + esc(S.userId) + '</span>' +
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

        var sendTimer = setTimeout(function () {
            if (S.sending) fail('Send timed out. Try again.');
        }, 7000);

        function onSendResult(err, res) {
            clearTimeout(sendTimer);
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
        }

        if (S.view === 'topic-chat' && S.currentTopic) {
            window.InkAPI.sendTopicMessage(S.currentTopic.id, text, S.token, deviceId, pendingReply, onSendResult);
        } else {
            window.InkAPI.sendMessage(text, S.token, deviceId, pendingReply, onSendResult);
        }

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

    // ── Polling / WebSocket ───────────────────────────────────────────────
    function fetchAndRender() {
        if (S.view === 'topic-chat' && S.currentTopic) {
            window.InkAPI.getTopicMessages(S.currentTopic.id, function (err, msgs) {
                if (!err && Array.isArray(msgs)) renderMessages(msgs);
            });
        } else if (S.view === 'general') {
            window.InkAPI.getMessages(function (err, msgs) {
                if (!err && Array.isArray(msgs)) renderMessages(msgs);
            });
        }
    }

    function startPoll() {
        if (!S.pollTimer) S.pollTimer = setInterval(fetchAndRender, 5000);
    }

    function stopPoll() {
        if (S.pollTimer) { clearInterval(S.pollTimer); S.pollTimer = null; }
    }

    function connectWS() {
        if (!window.WebSocket) { startPoll(); return; }
        if (S.ws && (S.ws.readyState === 0 || S.ws.readyState === 1)) return;

        var ws;
        try { ws = new WebSocket(window.InkAPI.wsBase + '/ws'); }
        catch (ex) { startPoll(); return; }

        S.ws = ws;

        ws.onopen    = function () { stopPoll(); setStatus(true); };
        ws.onmessage = function (e) {
            var data = null;
            try { data = JSON.parse(e.data); } catch (_) {}
            if (data && data.type === 'topic_notify') {
                if (S.view === 'topic-chat' && S.currentTopic && S.currentTopic.id === data.id) {
                    fetchAndRender();
                }
            } else {
                if (S.view === 'general') {
                    fetchAndRender();
                } else if (S.view === 'topics-list') {
                    var q = el('topics-search') ? el('topics-search').value : '';
                    loadTopics(q);
                }
            }
        };
        ws.onclose   = function () {
            S.ws = null;
            setStatus(false);
            if (S.userId) { startPoll(); setTimeout(connectWS, 4000); }
        };
        ws.onerror   = function () {};
    }

    function setStatus(live) {
        el('status-dot').classList.toggle('live', live);
        el('status-text').textContent = live ? 'Live' : '';
    }

    // ── Sign out ──────────────────────────────────────────────────────────
    function signOut() {
        stopPoll();
        if (S.ws) { try { S.ws.close(); } catch (e) {} S.ws = null; }
        try { localStorage.removeItem('inkchat_session_token'); } catch (e) {}
        window.InkAPI.logout(S.token, function () { window.location.reload(); });
    }

    // ── Modals ────────────────────────────────────────────────────────────
    function openTos(e)  { if (e) e.preventDefault(); show('tos-modal'); return false; }
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
        var clearBtn       = doc.createElement('button');
        clearBtn.className   = 'btn btn-sm';
        clearBtn.textContent = 'Clear All';
        clearBtn.onclick = function () {
            for (var i = 0; i < S.inbox.length; i++) S.dismissed[S.inbox[i].timestamp] = true;
            S.inbox = [];
            updateInboxBtn();
            closeInbox();
        };
        clearWrap.appendChild(clearBtn);
        body.appendChild(clearWrap);

        for (var i = 0; i < S.inbox.length; i++) {
            (function (m) {
                var uid   = S.userId.toLowerCase();
                var isRep = m.replyTo && (
                    m.replyTo.userId === S.userId ||
                    m.replyTo.userId.toLowerCase() === uid
                );
                var tag = isRep ? 'REPLY' : 'MENTION';

                var item = doc.createElement('div');
                item.style.cssText = 'border:2px solid #000;padding:11px;margin-bottom:10px;background:#fff;box-shadow:2px 2px 0 #ccc;';
                item.innerHTML =
                    '<div style="font-size:11px;color:#555;margin-bottom:5px;">' +
                        '<strong style="background:#000;color:#fff;padding:1px 5px;font-size:10px;margin-right:5px;">' + tag + '</strong>' +
                        'from @' + esc(m.userId) +
                    '</div>' +
                    '<div style="font-size:13px;margin-bottom:8px;">' + esc(m.text) + '</div>';

                var btns = doc.createElement('div');
                btns.style.cssText = 'display:flex;gap:6px;justify-content:flex-end;';

                var dismissBtn       = doc.createElement('button');
                dismissBtn.className   = 'btn btn-sm';
                dismissBtn.textContent = 'Dismiss';
                dismissBtn.onclick = function () {
                    S.dismissed[m.timestamp] = true;
                    S.inbox = S.inbox.filter(function (x) { return x.timestamp !== m.timestamp; });
                    updateInboxBtn();
                    closeInbox();
                    openInbox();
                };

                var focusBtn       = doc.createElement('button');
                focusBtn.className   = 'btn btn-sm';
                focusBtn.textContent = 'Go To';
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
            b.textContent   = 'Cancel';
        } else {
            f.style.display = 'none';
            b.textContent   = 'Change Password';
            el('pw-old').value = el('pw-new').value = el('pw-confirm').value = '';
            el('pw-status').style.display = 'none';
        }
    }

    function submitPwChange() {
        var old = el('pw-old').value, nw = el('pw-new').value, cf = el('pw-confirm').value;
        el('pw-status').style.display = 'none';

        if (!old || !nw || !cf) { setPwStatus('Fill in all fields.',     'red'); return; }
        if (nw !== cf)          { setPwStatus('Passwords do not match.', 'red'); return; }
        if (nw.length < 4)      { setPwStatus('Minimum 4 characters.',   'red'); return; }

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

        var inputRow = el('input-row');
        if (inputRow) {
            inputRow.parentNode.insertBefore(buildEmojiPicker(), inputRow);
        }

        restoreSession(function (ok) {
            if (ok) {
                launchChat();
            } else {
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
    if (window.InkDeviceId && !S.userId) onInkReady();

    // ── Expose to HTML ────────────────────────────────────────────────────
    window.switchTab           = switchTab;
    window.submitAuth          = submitAuth;
    window.submitSend          = submitSend;
    window.cancelReply         = cancelReply;
    window.signOut             = signOut;
    window.openTos             = openTos;
    window.closeTos            = closeTos;
    window.openInbox           = openInbox;
    window.closeInbox          = closeInbox;
    window.openSettings        = openSettings;
    window.closeSettings       = closeSettings;
    window.saveSettings        = saveSettings;
    window.togglePwForm        = togglePwForm;
    window.submitPwChange      = submitPwChange;
    window.toggleEmojiPicker   = toggleEmojiPicker;
    window.closeEmojiPicker    = closeEmojiPicker;
    window.switchView          = switchView;
    window.backToTopics        = backToTopics;
    window.topicsSearchChanged = topicsSearchChanged;
    window.openCreateTopic     = openCreateTopic;
    window.closeCreateTopic    = closeCreateTopic;
    window.submitCreateTopic   = submitCreateTopic;

}(window, document));
