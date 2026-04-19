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
      status: 200,
      headers: { 'Content-Type': 'text/plain' },
    });
  },
};

export class ChatRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.ctx = state;
  }

  async fetch(request) {
    const webSocketPair = new WebSocketPair();
    const [client, server] = Object.values(webSocketPair);

    const clientId = crypto.randomUUID();
    this.ctx.acceptWebSocket(server, [clientId]);

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  async webSocketOpen(ws) {
    const clientId = this.ctx.getTags(ws)[0];
    // 发送欢迎消息，包含 clientId
    ws.send(JSON.stringify({
      type: 'system',
      content: `已连接，你的临时 ID: ${clientId.slice(0,6)}`,
      clientId: clientId,
      timestamp: Date.now()
    }));
  }

  async webSocketMessage(ws, message) {
    const clientId = this.ctx.getTags(ws)[0];
    try {
      const data = JSON.parse(message);
      
      // 处理自定义用户名设置
      if (data.type === 'set_username') {
        // 存储用户名到连接元数据（可选，这里我们仅在消息中携带）
        // 实际上可以直接在后续消息中包含 username
        // 为了简单，让前端每次发送消息都带上 username
        return;
      }

      const payload = {
        type: data.type || 'message',
        clientId: clientId,
        username: data.username || '匿名',
        content: data.content,
        timestamp: Date.now(),
      };

      // 存储聊天消息（可选）
      if (payload.type === 'message') {
        await this.state.storage.put(`msg:${payload.timestamp}`, payload);
      }

      // 广播给所有连接
      await this.broadcast(payload);
    } catch (e) {
      console.error('消息处理错误:', e);
    }
  }

  async webSocketClose(ws, code, reason, wasClean) {
    const clientId = this.ctx.getTags(ws)[0];
    
    // 获取当前剩余连接数
    const sockets = this.ctx.getWebSockets();
    
    // 广播离开消息（可选）
    const leaveMsg = {
      type: 'system',
      content: `用户离开了房间`,
      timestamp: Date.now()
    };
    await this.broadcast(leaveMsg);

    // 如果没有连接了，延迟清理房间数据（防止立即有重连）
    if (sockets.length === 0) {
      // 设置一个 10 秒后触发的 alarm，用于清理存储
      await this.state.storage.setAlarm(Date.now() + 10000);
    }
  }

  async webSocketError(ws, error) {
    console.error('WebSocket error:', error);
  }

  // alarm 触发时清理房间数据
  async alarm() {
    const sockets = this.ctx.getWebSockets();
    if (sockets.length === 0) {
      // 删除所有存储数据
      await this.state.storage.deleteAll();
    }
  }

  async broadcast(payload) {
    const sockets = this.ctx.getWebSockets();
    const messageStr = JSON.stringify(payload);
    for (const socket of sockets) {
      try {
        socket.send(messageStr);
      } catch (e) {
        // ignore
      }
    }
  }
}