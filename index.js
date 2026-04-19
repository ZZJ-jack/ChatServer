export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const pathSegments = url.pathname.split('/').filter(Boolean);

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
    this.sessions = new Map();        // clientId -> { ws, username }
    this.usernames = new Set();       // 房间内已用用户名
  }

  async fetch(request) {
    const webSocketPair = new WebSocketPair();
    const [client, server] = Object.values(webSocketPair);
    const clientId = crypto.randomUUID();
    this.ctx.acceptWebSocket(server, [clientId]);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketOpen(ws) {
    // 连接打开后等待客户端发送 init 消息
  }

  async webSocketMessage(ws, message) {
    const clientId = this.ctx.getTags(ws)[0];

    try {
      const data = JSON.parse(message);

      // 处理初始化消息（设置用户名）
      if (data.type === 'init') {
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

        // 保存会话
        this.sessions.set(clientId, { ws, username });
        this.usernames.add(username);

        // 发送欢迎消息给该用户
        ws.send(JSON.stringify({
          type: 'system',
          content: `🎉 欢迎 ${username} 加入房间`,
          timestamp: Date.now()
        }));

        // 广播加入消息给其他人
        await this.broadcast({
          type: 'system',
          content: `👋 ${username} 加入了房间`,
          timestamp: Date.now()
        }, clientId);

        // 取消可能存在的 Alarm（房间现在有活跃用户）
        await this.state.storage.deleteAlarm();
        return;
      }

      // 处理普通聊天消息
      if (data.type === 'message') {
        const session = this.sessions.get(clientId);
        if (!session) return;

        const payload = {
          type: 'message',
          clientId: clientId,
          username: session.username,
          content: data.content,
          timestamp: Date.now()
        };

        // 可选：存储消息
        await this.state.storage.put(`msg:${payload.timestamp}`, payload);

        // 广播给所有人（包括自己）
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

    const { username } = session;
    this.sessions.delete(clientId);
    this.usernames.delete(username);

    // 广播离开消息
    await this.broadcast({
      type: 'system',
      content: `🚪 ${username} 离开了房间`,
      timestamp: Date.now()
    });

    // 如果房间内没有连接了，设置 Alarm 30 秒后自我销毁
    if (this.sessions.size === 0) {
      await this.state.storage.setAlarm(Date.now() + 30000);
    }
  }

  async webSocketError(ws, error) {
    console.error('WebSocket error:', error);
  }

  async alarm() {
    // 当 Alarm 触发时，若仍无连接，则删除 Durable Object 实例
    if (this.sessions.size === 0) {
      await this.ctx.storage.deleteAll();
      await this.ctx.storage.deleteAlarm();
    }
  }

  async broadcast(payload, excludeClientId = null) {
    const messageStr = JSON.stringify(payload);
    for (const [cid, session] of this.sessions.entries()) {
      if (cid === excludeClientId) continue;
      try {
        session.ws.send(messageStr);
      } catch (e) {
        // 发送失败忽略
      }
    }
  }
}