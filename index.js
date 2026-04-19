export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const pathSegments = url.pathname.split('/').filter(Boolean);

    // 用户名检查 API
    if (pathSegments.length === 1 && pathSegments[0] === 'check') {
      const room = url.searchParams.get('room');
      const username = url.searchParams.get('username');
      if (!room || !username) {
        return new Response(JSON.stringify({ error: 'Missing parameters' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      const id = env.CHAT_ROOM.idFromName(room);
      const roomObject = env.CHAT_ROOM.get(id);
      const checkResult = await roomObject.fetch('https://internal/check', {
        method: 'POST',
        body: JSON.stringify({ username }),
      });
      return checkResult;
    }

    // WebSocket 连接处理
    if (pathSegments.length >= 2 && pathSegments[0] === 'room') {
      const roomName = pathSegments[1];

      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('ChatServer is running', {
          headers: { 'Content-Type': 'text/plain' },
        });
      }

      const id = env.CHAT_ROOM.idFromName(roomName);
      const roomObject = env.CHAT_ROOM.get(id);
      return roomObject.fetch(request);
    }

    return new Response('ChatServer is running', {
      headers: { 'Content-Type': 'text/plain' },
    });
  },
};

export class ChatRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.ctx = state;
    this.sessions = new Map();        // clientId -> { ws, username, initialized }
    this.usernames = new Set();
  }

  // 处理来自 Worker 的 HTTP 请求（检查用户名）
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/check' && request.method === 'POST') {
      const { username } = await request.json();
      const nameRegex = /^[a-zA-Z0-9\u4e00-\u9fa5]{2,12}$/;
      if (!username || !nameRegex.test(username)) {
        return new Response(JSON.stringify({ valid: false, reason: 'invalid' }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      const exists = this.usernames.has(username);
      return new Response(JSON.stringify({ valid: !exists, reason: exists ? 'duplicate' : null }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // WebSocket 升级处理
    const webSocketPair = new WebSocketPair();
    const [client, server] = Object.values(webSocketPair);
    const clientId = crypto.randomUUID();
    this.ctx.acceptWebSocket(server, [clientId]);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketOpen(ws) {
    const clientId = this.ctx.getTags(ws)[0];
    // 先创建一个未初始化的 session，等待 init 消息
    this.sessions.set(clientId, { ws, username: null, initialized: false });
  }

  async webSocketMessage(ws, message) {
    const clientId = this.ctx.getTags(ws)[0];
    const session = this.sessions.get(clientId);
    if (!session) return;

    try {
      const data = JSON.parse(message);

      // 处理初始化消息
      if (data.type === 'init') {
        // 防止重复初始化
        if (session.initialized) {
          ws.send(JSON.stringify({
            type: 'error',
            code: 'ALREADY_INIT',
            message: '连接已初始化'
          }));
          return;
        }

        const username = data.username?.trim();
        const nameRegex = /^[a-zA-Z0-9\u4e00-\u9fa5]{2,12}$/;

        if (!username || !nameRegex.test(username)) {
          ws.send(JSON.stringify({
            type: 'error',
            code: 'INVALID_NAME',
            message: '用户名必须为2-12位中英文或数字'
          }));
          ws.close(1000, 'Invalid username');
          return;
        }

        if (this.usernames.has(username)) {
          ws.send(JSON.stringify({
            type: 'error',
            code: 'DUPLICATE_NAME',
            message: '用户名已被占用'
          }));
          ws.close(1000, 'Duplicate username');
          return;
        }

        // 更新 session 为已初始化
        session.username = username;
        session.initialized = true;
        this.usernames.add(username);

        // 发送欢迎消息给该用户
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
        }, clientId);

        await this.state.storage.deleteAlarm();
        return;
      }

      // 处理聊天消息（只有已初始化的会话才能发送）
      if (data.type === 'message') {
        if (!session.initialized) {
          ws.send(JSON.stringify({
            type: 'error',
            code: 'NOT_INIT',
            message: '请先设置用户名'
          }));
          return;
        }

        const payload = {
          type: 'message',
          clientId: clientId,
          username: session.username,
          content: data.content,
          timestamp: Date.now(),
          tempId: data.tempId
        };

        await this.state.storage.put(`msg:${payload.timestamp}`, payload);
        // 广播给所有人（包括自己，前端会通过 tempId 去重）
        await this.broadcast(payload);
      }
    } catch (e) {
      console.error('消息处理错误:', e);
    }
  }

  async webSocketClose(ws, code, reason, wasClean) {
    const clientId = this.ctx.getTags(ws)[0];
    const session = this.sessions.get(clientId);
    if (!session) return;

    const { username, initialized } = session;
    this.sessions.delete(clientId);
    if (initialized && username) {
      this.usernames.delete(username);
      // 广播离开消息
      await this.broadcast({
        type: 'system',
        content: `🚪 ${username} 离开了房间`,
        timestamp: Date.now()
      });
    }

    if (this.sessions.size === 0) {
      await this.state.storage.setAlarm(Date.now() + 30000);
    }
  }

  async webSocketError(ws, error) {
    console.error('WebSocket error:', error);
  }

  async alarm() {
    if (this.sessions.size === 0) {
      await this.ctx.storage.deleteAll();
      await this.ctx.storage.deleteAlarm();
    }
  }

  async broadcast(payload, excludeClientId = null) {
    const messageStr = JSON.stringify(payload);
    for (const [cid, session] of this.sessions.entries()) {
      if (cid === excludeClientId) continue;
      if (!session.initialized) continue; // 只发给已初始化的客户端
      try {
        session.ws.send(messageStr);
      } catch (e) {
        // 忽略发送失败
      }
    }
  }
}