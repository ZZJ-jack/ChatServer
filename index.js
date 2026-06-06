// index.js
import { DurableObject } from 'cloudflare:workers';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const pathSegments = url.pathname.split('/').filter(Boolean);

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    // 用户名检查
    if (pathSegments.length === 1 && pathSegments[0] === 'check') {
      const room = url.searchParams.get('room');
      const username = url.searchParams.get('username');
      if (!room || !username) {
        return new Response(JSON.stringify({ error: 'Missing parameters' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        });
      }

      const id = env.CHAT_ROOM.idFromName(room);
      const roomObject = env.CHAT_ROOM.get(id);
      const checkResult = await roomObject.fetch('https://internal/check', {
        method: 'POST',
        body: JSON.stringify({ username }),
      });

      const response = new Response(checkResult.body, checkResult);
      response.headers.set('Access-Control-Allow-Origin', '*');
      return response;
    }

    // WebSocket 入口
    if (pathSegments.length >= 3 && pathSegments[0] === 'room' && pathSegments[2] === 'ws') {
      const roomName = pathSegments[1];
      const upgradeHeader = request.headers.get('Upgrade');

      if (upgradeHeader !== 'websocket') {
        return new Response('Expected WebSocket Upgrade', {
          status: 426,
          headers: { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' },
        });
      }

      if (request.method !== 'GET') {
        return new Response('Method not allowed', {
          status: 405,
          headers: { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' },
        });
      }

      const id = env.CHAT_ROOM.idFromName(roomName);
      const roomObject = env.CHAT_ROOM.get(id);
      return roomObject.fetch(request);
    }

    return new Response('ChatServer is running', {
      headers: { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' },
    });
  },
};

// Durable Object
export class ChatRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sessions = new Map();

    this.ctx.getWebSockets().forEach((ws) => {
      const attachment = ws.deserializeAttachment();
      if (attachment && attachment.username) {
        this.sessions.set(ws, { username: attachment.username });
      }
    });
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/check' && request.method === 'POST') {
      const { username } = await request.json();
      let isTaken = false;
      for (const session of this.sessions.values()) {
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
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketOpen(ws) {
    ws.serializeAttachment({ username: null });
    this.sessions.set(ws, { username: null });
  }

  async webSocketMessage(ws, message) {
    let session = this.sessions.get(ws);
    if (!session) {
      const attachment = ws.deserializeAttachment() || {};
      session = { username: attachment.username || null };
      this.sessions.set(ws, session);
    }

    try {
      const data = JSON.parse(message);

      // 心跳包处理：收到 ping 回复 pong，保持连接活跃
      if (data.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
        return;
      }

      // 初始化
      if (data.type === 'init') {
        const username = data.username?.trim();
        const nameRegex = /^[a-zA-Z0-9\u4e00-\u9fa5]{2,12}$/;

        if (!username || !nameRegex.test(username)) {
          ws.send(JSON.stringify({
            type: 'error',
            code: 'INVALID_NAME',
            message: '用户名格式不正确',
          }));
          ws.close(1000, 'Invalid username');
          return;
        }

        let isTaken = false;
        for (const s of this.sessions.values()) {
          if (s.username === username) {
            isTaken = true;
            break;
          }
        }
        if (isTaken) {
          ws.send(JSON.stringify({
            type: 'error',
            code: 'DUPLICATE_NAME',
            message: '用户名已被占用',
          }));
          ws.close(1000, 'Duplicate username');
          return;
        }

        session.username = username;
        ws.serializeAttachment({ username });

        ws.send(JSON.stringify({
          type: 'system',
          content: `🎉 欢迎 ${username} 加入房间`,
          timestamp: Date.now(),
        }));

        await this.broadcast(
          {
            type: 'system',
            content: `👋 ${username} 加入了房间`,
            timestamp: Date.now(),
          },
          ws
        );
        return;
      }

      // 聊天消息
      if (data.type === 'message') {
        if (!session.username) {
          ws.send(JSON.stringify({ type: 'error', code: 'NOT_INIT', message: '请先设置用户名' }));
          return;
        }

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
    const attachment = ws.deserializeAttachment();
    const username = session?.username || attachment?.username;

    if (username) {
      await this.broadcast(
        {
          type: 'system',
          content: `🚪 ${username} 离开了房间`,
          timestamp: Date.now(),
        },
        ws
      );
    }

    this.sessions.delete(ws);
  }

  async webSocketError(ws, error) {
    const session = this.sessions.get(ws);
    const attachment = ws.deserializeAttachment();
    const username = session?.username || attachment?.username;

    if (username) {
      await this.broadcast(
        {
          type: 'system',
          content: `🚪 ${username} 离开了房间`,
          timestamp: Date.now(),
        },
        ws
      );
    }

    this.sessions.delete(ws);
  }

  async broadcast(payload, excludeWs = null) {
    const messageStr = JSON.stringify(payload);
    const sockets = this.ctx.getWebSockets();

    for (const ws of sockets) {
      if (ws === excludeWs) continue;
      try {
        ws.send(messageStr);
      } catch (e) {
        console.error('广播发送失败:', e);
      }
    }
  }
}