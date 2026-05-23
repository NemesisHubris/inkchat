export class ChatRoom {
    constructor(state, env) {
        this.state = state;
        this.env   = env;
    }

    async fetch(request) {
        if (request.headers.get('Upgrade') === 'websocket') {
            const [client, server] = Object.values(new WebSocketPair());
            this.state.acceptWebSocket(server);
            return new Response(null, { status: 101, webSocket: client });
        }

        if (request.method === 'POST') {
            const msg = await request.text();
            for (const ws of this.state.getWebSockets()) {
                try { ws.send(msg); } catch (_) {}
            }
            return new Response('OK');
        }

        return new Response('Not found', { status: 404 });
    }

    webSocketMessage() {}
    webSocketClose()   {}
    webSocketError()   {}
}
