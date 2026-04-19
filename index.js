// index.js

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const pathSegments = url.pathname.split('/').filter(Boolean);

    // 处理 CORS 预检请求
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    // 用户名检查 API
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

      // 复制响应并添加 CORS 头
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
    this.sessions = new Map(); // WebSocket -> { username, initialized? 我们直接存 username }
  }

  // 处理内部 HTTP 请求（用户名检查）
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/check' && request.method === 'POST') {
      const { username } = await request.json();

      // 检查用户名是否被占用（遍历活跃会话）
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

  async webSocketOpen(ws) {
    // 初始化一个空会话，等待 init 消息
    this.sessions.set(ws, { username: null });
  }

  async webSocketMessage(ws, message) {
    const session = this.sessions.get(ws);
    if (!session) return;

    try {
      const data = JSON.parse(message);

      // 处理初始化消息
      if (data.type === 'init') {
        const username = data.username?.trim();
        const nameRegex = /^[a-zA-Z0-9\u4e00-\u9fa5]{2,12}$/;

        if (!username || !nameRegex.test(username)) {
          ws.send(JSON.stringify({ type: 'error', code: 'INVALID_NAME', message: '用户名格式不正确' }));
          ws.close(1000, 'Invalid username');
          return;
        }

        // 再次检查重复
        let isTaken = false;
        for (let s of this.sessions.values()) {
          if (s.username === username) {
            isTaken = true;
            break;
          }
        }
        if (isTaken) {
          ws.send(JSON.stringify({ type: 'error', code: 'DUPLICATE_NAME', message: '用户名已被占用' }));
          ws.close(1000, 'Duplicate username');
          return;
        }

        // 更新会话
        session.username = username;

        // 发送欢迎消息给当前用户
        ws.send(JSON.stringify({
          type: 'system',
          content: `🎉 欢迎 ${username} 加入房间`,
          timestamp: Date.now()
        }));

        // 广播加入消息给其他人（排除自己）
        await this.broadcast({
          type: 'system',
          content: `👋 ${username} 加入了房间`,
          timestamp: Date.now()
        }, ws);

        return;
      }

      // 处理聊天消息
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
          tempId: data.tempId // 回传临时ID
        };

        // 广播给所有连接的客户端（包括自己）
        await this.broadcast(payload);
      }
    } catch (e) {
      console.error('消息处理错误:', e);
    }
  }

  async webSocketClose(ws, code, reason, wasClean) {
    const session = this.sessions.get(ws);
    if (session && session.username) {
      // 广播离开消息给其他人
      await this.broadcast({
        type: 'system',
        content: `🚪 ${session.username} 离开了房间`,
        timestamp: Date.now()
      }, ws);
    }
    this.sessions.delete(ws);
  }

  async webSocketError(ws, error) {
    const session = this.sessions.get(ws);
    if (session && session.username) {
      await this.broadcast({
        type: 'system',
        content: `🚪 ${session.username} 离开了房间`,
        timestamp: Date.now()
      }, ws);
    }
    this.sessions.delete(ws);
  }

  // 广播消息给所有活跃连接
  async broadcast(payload, excludeWs = null) {
    const messageStr = JSON.stringify(payload);
    for (let [ws, session] of this.sessions.entries()) {
      if (ws === excludeWs) continue;
      try {
        ws.send(messageStr);
      } catch (e) {
        // 发送失败，可能连接已死，但我们会在下次 close/error 中清理
        console.error('广播发送失败:', e);
      }
    }
  }
}