// index.js
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const pathSegments = url.pathname.split('/').filter(Boolean);

    // 处理 CORS 预检请求 (OPTIONS)
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    // API: 检查用户名是否可用
    if (pathSegments.length === 1 && pathSegments[0] === 'check') {
      const room = url.searchParams.get('room');
      const username = url.searchParams.get('username');
      if (!room || !username) {
        return new Response(JSON.stringify({ error: 'Missing parameters' }), {
          status: 400,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          },
        });
      }

      const id = env.CHAT_ROOM.idFromName(room);
      const roomObject = env.CHAT_ROOM.get(id);
      const checkResult = await roomObject.fetch('https://internal/check', {
        method: 'POST',
        body: JSON.stringify({ username }),
      });

      // 克隆响应以便添加 CORS 头
      const response = new Response(checkResult.body, checkResult);
      response.headers.set('Access-Control-Allow-Origin', '*');
      return response;
    }

    // WebSocket 连接
    if (pathSegments.length >= 2 && pathSegments[0] === 'room') {
      const roomName = pathSegments[1];

      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('ChatServer is running', {
          headers: {
            'Content-Type': 'text/plain',
            'Access-Control-Allow-Origin': '*',
          },
        });
      }

      const id = env.CHAT_ROOM.idFromName(roomName);
      const roomObject = env.CHAT_ROOM.get(id);
      return roomObject.fetch(request);
    }

    return new Response('ChatServer is running', {
      headers: {
        'Content-Type': 'text/plain',
        'Access-Control-Allow-Origin': '*',
      },
    });
  },
};

export class ChatRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = new Map(); // WebSocket -> { username }
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/check' && request.method === 'POST') {
      const { username } = await request.json();

      let isTaken = false;
      for (let session of this.sessions.values()) {
        if (session.username === username) {
          isTaken = true;
          break;
        }
      }

      return new Response(JSON.stringify({ valid: !isTaken }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // WebSocket 升级
    const webSocketPair = new WebSocketPair();
    const [client, server] = Object.values(webSocketPair);
    this.state.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    try {
      const data = JSON.parse(message);

      if (data.type === 'init') {
        const username = data.username?.trim();

        let isTaken = false;
        for (let session of this.sessions.values()) {
          if (session.username === username) {
            isTaken = true;
            break;
          }
        }
        if (isTaken) {
          ws.send(JSON.stringify({ type: 'error', code: 'DUPLICATE_NAME', message: '用户名已被占用' }));
          ws.close(1000, 'Duplicate username');
          return;
        }

        this.sessions.set(ws, { username });

        ws.send(JSON.stringify({ type: 'system', content: `🎉 欢迎 ${username} 加入房间`, timestamp: Date.now() }));
        await this.broadcast({ type: 'system', content: `👋 ${username} 加入了房间`, timestamp: Date.now() }, ws);
        return;
      }

      if (data.type === 'message') {
        const session = this.sessions.get(ws);
        if (!session) return;

        const payload = {
          type: 'message',
          username: session.username,
          content: data.content,
          timestamp: Date.now(),
          tempId: data.tempId,
        };

        await this.broadcast(payload);
      }
    } catch (e) {
      console.error('消息处理错误:', e);
    }
  }

  async webSocketClose(ws, code, reason, wasClean) {
    const session = this.sessions.get(ws);
    if (session) {
      await this.broadcast({ type: 'system', content: `🚪 ${session.username} 离开了房间`, timestamp: Date.now() });
      this.sessions.delete(ws);
    }
  }

  async webSocketError(ws, error) {
    const session = this.sessions.get(ws);
    if (session) {
      await this.broadcast({ type: 'system', content: `🚪 ${session.username} 离开了房间`, timestamp: Date.now() });
      this.sessions.delete(ws);
    }
  }

  async broadcast(payload, excludeWs = null) {
    const messageStr = JSON.stringify(payload);
    for (let [ws, session] of this.sessions.entries()) {
      if (ws === excludeWs) continue;
      try {
        ws.send(messageStr);
      } catch (e) {}
    }
  }
}