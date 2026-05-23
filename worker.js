// Gate the main chat page to e-ink devices only.
// Admin panel (/admin.html) and all static assets pass through for everyone.
const EINK_RE = /kindle|silk|kobo|e[\-\s]?ink|eink|remarkable|boox|pocketbook/i;

export default {
    async fetch(request, env) {
        const url  = new URL(request.url);
        const path = url.pathname;

        if (path === '/' || path === '/index.html') {
            const ua = request.headers.get('User-Agent') || '';
            if (!EINK_RE.test(ua)) {
                return new Response(BLOCKED_HTML, {
                    status:  403,
                    headers: { 'Content-Type': 'text/html;charset=utf-8' }
                });
            }
        }

        return env.ASSETS.fetch(request);
    }
};

const BLOCKED_HTML = `<!DOCTYPE html>
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
