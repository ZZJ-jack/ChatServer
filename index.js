// index.js
import { DurableObject } from 'cloudflare:workers';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const pathSegments = url.pathname.split('/').filter(Boolean);

    // CORS 预检
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    // 用户名检查 API：/check?room=xxx&username=yyy
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

    // WebSocket 入口：/room/:name/ws（加上 /ws 更清晰）
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

// Durable Object：聊天房间
export class ChatRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sessions = new Map(); // 仅作辅助，真实连接以 ctx.getWebSockets() 为准

    // 从 Hibernation 恢复时，把已有的 WebSocket 重新放入 sessions
    this.ctx.getWebSockets().forEach((ws) => {
      const attachment = ws.deserializeAttachment();
      if (attachment && attachment.username) {
        this.sessions.set(ws, { username: attachment.username });
      }
    });
  }

  async fetch(request) {
    const url = new URL(request.url);

    // 内部 HTTP 接口：用户名重复检查
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

    // 使用 Hibernation API 接受 WebSocket
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketOpen(ws) {
    // 初始状态，username 为 null，等待 init
    ws.serializeAttachment({ username: null });
    this.sessions.set(ws, { username: null });
  }

  async webSocketMessage(ws, message) {
    let session = this.sessions.get(ws);
    if (!session) {
      // 防御性：如果 Map 里没有，但 ws 在 ctx.getWebSockets() 中，重建 session
      const attachment = ws.deserializeAttachment() || {};
      session = { username: attachment.username || null };
      this.sessions.set(ws, session);
    }

    try {
      const data = JSON.parse(message);

      // 初始化（设置用户名）
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

        // 再次检查重复
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

        // 更新本地状态 & 附件
        session.username = username;
        ws.serializeAttachment({ username });

        // 欢迎消息
        ws.send(JSON.stringify({
          type: 'system',
          content: `🎉 欢迎 ${username} 加入房间`,
          timestamp: Date.now(),
        }));

        // 广播给其他人
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
          tempId: data.tempId, // 回传临时 ID，方便前端去重/替换
        };

        // 广播给所有人（包括自己）
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
    // Hibernation 场景下可不再调用 ws.close()，见官方说明
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

  // 广播：优先使用 ctx.getWebSockets()，与 Hibernation 保持一致
  async broadcast(payload, excludeWs = null) {
    const messageStr = JSON.stringify(payload);
    const sockets = this.ctx.getWebSockets();

    for (const ws of sockets) {
      if (ws === excludeWs) continue;
      try {
        ws.send(messageStr);
      } catch (e) {
        // 发送失败，可以记录日志；DO 会在 close/error 中清理
        console.error('广播发送失败:', e);
      }
    }
  }
}
