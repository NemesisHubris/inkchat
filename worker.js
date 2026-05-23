const EINK_RE = /kindle|silk|kobo|e[\-\s]?ink|eink|remarkable|boox|pocketbook/i;

const BLOCK_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>InkChat</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:"Geneva","Verdana",monospace;background:#bbb;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}
.box{background:#fff;border:2px solid #000;box-shadow:5px 5px 0 #000;padding:40px 36px;text-align:center;max-width:380px;width:100%}
h1{font-size:16px;font-weight:bold;text-transform:uppercase;letter-spacing:2px;margin-bottom:20px}
.stripe{height:6px;background:repeating-linear-gradient(90deg,#000 0,#000 2px,transparent 2px,transparent 4px);margin-bottom:20px}
p{font-size:13px;line-height:1.7;color:#333}
small{display:block;margin-top:16px;font-size:11px;color:#777}
</style>
</head>
<body>
<div class="box">
  <div class="stripe"></div>
  <h1>InkChat</h1>
  <p>You can only access InkChat from your Kindle or Kobo.</p>
  <small>Open this page on an e&#8209;ink device to continue.</small>
  <div class="stripe" style="margin-top:20px;margin-bottom:0"></div>
</div>
</body>
</html>`;

const APP_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>InkChat</title>
    <link rel="stylesheet" href="style.css">
</head>
<body>

<!-- ── Auth screen ──────────────────────────────────────────── -->
<div id="auth-screen">
    <div class="auth-card">
        <div class="auth-tabs">
            <button id="tab-login" class="auth-tab active" onclick="switchTab('login')">Log In</button>
            <button id="tab-reg"   class="auth-tab"        onclick="switchTab('register')">Register</button>
        </div>
        <div class="auth-body">
            <form onsubmit="return submitAuth(event)">
                <div class="field">
                    <label for="f-user">Username</label>
                    <input id="f-user" type="text"
                        autocomplete="username" autocapitalize="off"
                        spellcheck="false" maxlength="32">
                    <div class="field-hint">Letters, numbers, and underscores only.</div>
                </div>
                <div class="field">
                    <label for="f-pass">Password</label>
                    <input id="f-pass" type="password"
                        autocomplete="current-password" maxlength="128">
                </div>
                <div id="tos-row" class="tos-row">
                    <input id="tos-check" type="checkbox">
                    <label for="tos-check">
                        I accept the <a href="#" onclick="return openTos(event)">Terms of Use</a>
                    </label>
                </div>
                <button id="auth-btn" class="btn auth-submit" type="submit">Log In</button>
                <div id="auth-err" class="auth-error"></div>
            </form>
        </div>
    </div>
</div>

<!-- ── Main app shell ───────────────────────────────────────── -->
<div id="app">

    <!-- Title bar -->
    <div class="titlebar">
        <div class="titlebar-stripes"></div>
        <div class="titlebar-left">
            <span id="user-label"></span>
        </div>
        <div class="titlebar-title">InkChat</div>
        <div class="titlebar-right">
            <button id="inbox-btn" class="btn btn-sm" onclick="openInbox()">Inbox</button>
            <button class="btn btn-sm" onclick="openSettings()">Settings</button>
            <button class="btn btn-sm" onclick="signOut()">Sign Out</button>
        </div>
    </div>

    <!-- Message list -->
    <div id="messages"></div>

    <!-- Input area -->
    <div id="input-area">
        <div id="reply-bar">
            <span id="reply-text"></span>
            <button class="btn btn-sm" onclick="cancelReply()">Cancel</button>
        </div>
        <div id="send-error"></div>
        <div id="input-row">
            <button id="emoji-toggle" onclick="toggleEmojiPicker()" type="button">&#9786;</button>
            <textarea id="msg-input" placeholder="Type a message…" disabled></textarea>
            <button id="send-btn" class="btn" onclick="return submitSend(event)" disabled>Send</button>
        </div>
    </div>

    <!-- Status bar -->
    <div id="statusbar">
        <div id="status-dot" class="status-dot"></div>
        <span id="status-text">Connecting…</span>
    </div>

</div>

<!-- ── Toast notice ─────────────────────────────────────────── -->
<div id="notice"></div>

<!-- ── Terms of Use modal ───────────────────────────────────── -->
<div id="tos-modal" class="overlay">
    <div class="modal">
        <div class="titlebar">
            <div class="titlebar-stripes"></div>
            <div class="titlebar-title">Terms of Use</div>
            <div class="titlebar-right">
                <button class="icon-btn" onclick="closeTos()">X</button>
            </div>
        </div>
        <div class="modal-body">
            <p>InkChat is an open chat room. By registering you agree to:</p>
            <ul style="margin:10px 0 0 18px;line-height:1.8;">
                <li>Be respectful to all participants.</li>
                <li>Not post spam, advertisements, or off-topic links.</li>
                <li>Not post illegal, violent, or sexually explicit material.</li>
                <li>Accept that messages may be moderated or removed at any time.</li>
                <li>Understand that repeat violations result in a permanent ban.</li>
            </ul>
            <div class="modal-btns">
                <button class="btn" onclick="closeTos()">Close</button>
            </div>
        </div>
    </div>
</div>

<!-- ── Inbox modal ──────────────────────────────────────────── -->
<div id="inbox-modal" class="overlay">
    <div class="modal">
        <div class="titlebar">
            <div class="titlebar-stripes"></div>
            <div class="titlebar-title">Inbox</div>
            <div class="titlebar-right">
                <button class="icon-btn" onclick="closeInbox()">X</button>
            </div>
        </div>
        <div id="inbox-body" class="modal-body"></div>
    </div>
</div>

<!-- ── Settings modal ───────────────────────────────────────── -->
<div id="settings-modal" class="overlay">
    <div class="modal">
        <div class="titlebar">
            <div class="titlebar-stripes"></div>
            <div class="titlebar-title">Settings</div>
            <div class="titlebar-right">
                <button class="icon-btn" onclick="closeSettings()">X</button>
            </div>
        </div>
        <div class="modal-body">
            <label style="display:flex;align-items:center;gap:8px;cursor:pointer;-webkit-user-select:none;user-select:none;">
                <input id="setting-enter" type="checkbox">
                Send with Enter (Shift+Enter for newline)
            </label>

            <div style="margin-top:18px;border-top:1px solid #ccc;padding-top:14px;">
                <button id="pw-toggle" class="btn btn-sm" onclick="togglePwForm()">Change Password</button>
                <div id="pw-form" style="display:none;margin-top:12px;">
                    <input id="pw-old"     class="modal-input" type="password" placeholder="Current password">
                    <input id="pw-new"     class="modal-input" type="password" placeholder="New password">
                    <input id="pw-confirm" class="modal-input" type="password" placeholder="Confirm new password">
                    <button class="btn" onclick="submitPwChange()">Update Password</button>
                    <div id="pw-status"></div>
                </div>
            </div>

            <div class="modal-btns">
                <button class="btn btn-sm" onclick="closeSettings()">Cancel</button>
                <button class="btn" onclick="saveSettings()">Save</button>
            </div>
        </div>
    </div>
</div>

<script>
// Secondary screen-size gate.
// Known e-ink resolutions (portrait and landscape):
//   Kindle Paperwhite 1-3:  758x1024
//   Kindle Paperwhite 4-5:  1072x1448
//   Kindle Oasis 2-3:       1264x1680
//   Kindle Scribe:          1860x2480
//   Kobo Clara / Libra:     1072x1448 / 1264x1680
//   Kobo Elipsa / Sage:     1404x1872 / 1440x1920
//   reMarkable 2:           1404x1872
//   Boox Note Air:          1404x1872
// Allow ±10px tolerance for browser chrome/zoom.
(function() {
  var w = screen.width, h = screen.height;
  var long = Math.max(w, h), short = Math.min(w, h);
  var known = [
    // Kindle Scribe 2025
    [1986,2648],
    // Kindle Scribe / Scribe 2024
    [1860,2480],
    // Kindle Colorsoft, Paperwhite 6 / 6 Sig Ed
    [1272,1696],
    // Kindle PW 12th Gen, Oasis 2/3, Kobo Libra 2/H2O, Boox Page, PocketBook Era
    [1264,1680],
    // Kindle PW 5 / 11th Gen, PW 5 Sig Ed
    [1236,1648],
    // Kindle 11/2024, PW 3/4/10th, Oasis 1, Voyage, Kobo Clara BW/2E/HD, Nook GlowLight 4
    [1072,1448],
    // Kobo Elipsa 2E, reMarkable 2, Boox Note Air/Tab Ultra, PocketBook InkPad 4
    [1404,1872],
    // Kobo Sage
    [1440,1920],
    // Kindle PW 1/2, Kobo Nia
    [758,1024],
    // Kindle DX
    [824,1200],
    // Boox Palma
    [824,1648],
    // Kindle 1–10, Touch, Keyboard
    [600,800]
  ];
  var TOL = 20;
  var ok = false;
  for (var i = 0; i < known.length; i++) {
    var kl = Math.max(known[i][0], known[i][1]);
    var ks = Math.min(known[i][0], known[i][1]);
    if (Math.abs(long - kl) <= TOL && Math.abs(short - ks) <= TOL) { ok = true; break; }
  }
  if (!ok) {
    document.documentElement.innerHTML = document.documentElement.innerHTML
      .replace(/<body[\s\S]*$/i, '') + '<body style="font-family:monospace;background:#bbb;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="background:#fff;border:2px solid #000;box-shadow:5px 5px 0 #000;padding:40px;text-align:center;max-width:380px"><div style="height:6px;background:repeating-linear-gradient(90deg,#000 0,#000 2px,transparent 2px,transparent 4px);margin-bottom:20px"></div><b style="display:block;font-size:14px;text-transform:uppercase;letter-spacing:2px;margin-bottom:16px">InkChat</b><p style="font-size:13px;line-height:1.7">You can only access InkChat from your Kindle or Kobo.</p><div style="height:6px;background:repeating-linear-gradient(90deg,#000 0,#000 2px,transparent 2px,transparent 4px);margin-top:20px"></div></div></body></html>';
  }
})();
</script>
<script src="telemetry.js"></script>
<script src="app.js"></script>
</body>
</html>`;

export default {
    async fetch(request, env) {
        const url  = new URL(request.url);
        const path = url.pathname;

        // Serve the app — Kindle/e-ink only
        if (path === '/' || path === '/index.html') {
            const ua = request.headers.get('User-Agent') || '';
            if (!EINK_RE.test(ua)) {
                return new Response(BLOCK_HTML, {
                    status:  403,
                    headers: { 'Content-Type': 'text/html;charset=utf-8' }
                });
            }
            return new Response(APP_HTML, {
                status:  200,
                headers: { 'Content-Type': 'text/html;charset=utf-8' }
            });
        }

        // Everything else (CSS, JS, admin, etc.) passes through
        return env.ASSETS.fetch(request);
    }
};
