export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const pathSegments = url.pathname.split('/').filter(Boolean);

    // API: 检查用户名是否可用 (GET /check?room=xxx&username=yyy)
    if (pathSegments.length === 1 && pathSegments[0] === 'check') {
      const room = url.searchParams.get('room');
      const username = url.searchParams.get('username');
      if (!room || !username) {
        return new Response(JSON.stringify({ error: 'Missing parameters' }), {
          status: 400, headers: { 'Content-Type': 'application/json' }
        });
      }

      // 获取对应房间的 Durable Object，并调用其内部检查逻辑
      const id = env.CHAT_ROOM.idFromName(room);
      const roomObject = env.CHAT_ROOM.get(id);
      return roomObject.fetch('https://internal/check', {
        method: 'POST',
        body: JSON.stringify({ username })
      });
    }

    // 处理 WebSocket 连接 (wss://xxx/room/xxx)
    if (pathSegments.length >= 2 && pathSegments[0] === 'room') {
      const roomName = pathSegments[1];
      if (request.headers.get('Upgrade') !== 'websocket') {
        // 对于非 WebSocket 的普通 HTTP 请求，返回一个纯文本响应
        return new Response('ChatServer is running', {
          headers: { 'Content-Type': 'text/plain' },
        });
      }

      const id = env.CHAT_ROOM.idFromName(roomName);
      const roomObject = env.CHAT_ROOM.get(id);
      return roomObject.fetch(request);
    }

    // 其他所有请求均返回 "ChatServer is running"
    return new Response('ChatServer is running', {
      headers: { 'Content-Type': 'text/plain' },
    });
  },
};

// 聊天室 Durable Object 类
export class ChatRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    // sessions: WebSocket -> { username, ... }
    // 我们直接使用 Map 的键来存储活跃连接，无需额外的 usernames 集合
    this.sessions = new Map();
  }

  // 处理来自 Worker 的 HTTP 请求（例如检查用户名）
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/check' && request.method === 'POST') {
      const { username } = await request.json();
      
      // 核心修改：直接遍历当前所有活跃会话，检查用户名是否已被占用
      let isTaken = false;
      for (let session of this.sessions.values()) {
        if (session.username === username) {
          isTaken = true;
          break;
        }
      }
      
      // 返回检查结果
      return new Response(JSON.stringify({ valid: !isTaken }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // WebSocket 升级逻辑
    const webSocketPair = new WebSocketPair();
    const [client, server] = Object.values(webSocketPair);
    this.state.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    try {
      const data = JSON.parse(message);

      // 1. 处理初始化消息，设置用户名
      if (data.type === 'init') {
        const username = data.username?.trim();
        
        // 再次进行用户名重复性检查，防止并发冲突
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

        // 将新会话存储到 Map 中
        this.sessions.set(ws, { username });
        
        // 发送欢迎消息
        ws.send(JSON.stringify({ type: 'system', content: `🎉 欢迎 ${username} 加入房间`, timestamp: Date.now() }));
        
        // 广播用户加入消息给其他人
        await this.broadcast({ type: 'system', content: `👋 ${username} 加入了房间`, timestamp: Date.now() }, ws);
        return;
      }

      // 2. 处理聊天消息
      if (data.type === 'message') {
        const session = this.sessions.get(ws);
        if (!session) return;

        const payload = {
          type: 'message',
          username: session.username,
          content: data.content,
          timestamp: Date.now(),
          tempId: data.tempId
        };
        
        // 广播消息给所有用户
        await this.broadcast(payload);
      }
      
    } catch (e) {
      console.error('消息处理错误:', e);
    }
  }

  async webSocketClose(ws, code, reason, wasClean) {
    const session = this.sessions.get(ws);
    if (session) {
      // 广播用户离开消息
      await this.broadcast({ type: 'system', content: `🚪 ${session.username} 离开了房间`, timestamp: Date.now() });
      this.sessions.delete(ws);
    }
  }

  async webSocketError(ws, error) {
    // 发生错误时，同样需要清理该连接
    const session = this.sessions.get(ws);
    if (session) {
      await this.broadcast({ type: 'system', content: `🚪 ${session.username} 离开了房间`, timestamp: Date.now() });
      this.sessions.delete(ws);
    }
  }

  // 广播消息给所有已连接的客户端
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