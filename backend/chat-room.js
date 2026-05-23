// Durable Object: one singleton instance ("main") holds all active WebSocket connections.
// The main Worker calls POST / to broadcast a notification; clients call GET / with
// Upgrade: websocket to subscribe.  We use Cloudflare's Hibernatable WebSockets API so
// the DO doesn't burn CPU between messages.

export class ChatRoom {
    constructor(state, env) {
        this.state = state;
        this.env   = env;
    }

    async fetch(request) {
        if (request.headers.get("Upgrade") === "websocket") {
            const [client, server] = Object.values(new WebSocketPair());
            this.state.acceptWebSocket(server);
            return new Response(null, { status: 101, webSocket: client });
        }

        if (request.method === "POST") {
            const body    = await request.text();
            const sockets = this.state.getWebSockets();
            for (const ws of sockets) {
                try { ws.send(body); } catch (_) {}
            }
            return new Response("OK");
        }

        return new Response("Not found", { status: 404 });
    }

    webSocketMessage() {}
    webSocketClose()   {}
    webSocketError()   {}
}
