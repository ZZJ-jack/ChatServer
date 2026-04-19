// src/index.js

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const pathSegments = url.pathname.split('/').filter(Boolean);

    // 仅处理 /room/:roomName 的 WebSocket 升级请求
    if (pathSegments.length >= 2 && pathSegments[0] === 'room') {
      const roomName = pathSegments[1];

      // 检查是否为 WebSocket 升级请求
      if (request.headers.get('Upgrade') !== 'websocket') {
        // 非 WebSocket 请求（例如浏览器地址栏访问），返回简单文本
        return new Response('ChatServer is running', {
          headers: { 'Content-Type': 'text/plain' },
        });
      }

      // 处理 WebSocket 连接
      const id = env.CHAT_ROOM.idFromName(roomName);
      const roomObject = env.CHAT_ROOM.get(id);
      return roomObject.fetch(request);
    }

    // 其他路径返回 404 或同样显示运行状态
    return new Response('ChatServer is running', {
      status: 200,
      headers: { 'Content-Type': 'text/plain' },
    });
  },
};

// Durable Object 类：聊天室
export class ChatRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.ctx = state; // 用于 Hibernation API
  }

  async fetch(request) {
    const webSocketPair = new WebSocketPair();
    const [client, server] = Object.values(webSocketPair);

    // 为每个连接生成唯一 ID
    const clientId = crypto.randomUUID();

    // 接受 WebSocket 连接，并附带 clientId 作为标签
    this.ctx.acceptWebSocket(server, [clientId]);

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  // 当 WebSocket 连接建立时触发（可选）
  async webSocketOpen(ws) {
    const clientId = this.ctx.getTags(ws)[0];
    // 向该客户端发送欢迎消息（包含其 clientId）
    ws.send(
      JSON.stringify({
        type: 'system',
        content: `已连接至聊天室，你的 ID 是 ${clientId.slice(0, 6)}`,
        clientId: clientId,
        timestamp: Date.now(),
      })
    );

    // 广播加入消息
    const joinMsg = {
      type: 'system',
      content: `用户 ${clientId.slice(0, 6)} 加入了房间`,
      timestamp: Date.now(),
    };
    await this.broadcast(joinMsg);
  }

  // 收到客户端消息
  async webSocketMessage(ws, message) {
    const clientId = this.ctx.getTags(ws)[0];

    try {
      const data = JSON.parse(message);
      const payload = {
        type: data.type || 'message',
        clientId: clientId,
        content: data.content,
        timestamp: Date.now(),
      };

      // 仅存储普通聊天消息（可选，用于历史记录）
      if (payload.type === 'message') {
        await this.state.storage.put(`msg:${payload.timestamp}`, payload);
      }

      // 广播给所有连接的客户端
      await this.broadcast(payload);
    } catch (e) {
      console.error('消息解析失败:', e);
    }
  }

  // 连接关闭
  async webSocketClose(ws, code, reason, wasClean) {
    const clientId = this.ctx.getTags(ws)[0];
    const leaveMsg = {
      type: 'system',
      content: `用户 ${clientId.slice(0, 6)} 离开了房间`,
      timestamp: Date.now(),
    };
    await this.broadcast(leaveMsg);
  }

  // 连接错误
  async webSocketError(ws, error) {
    console.error('WebSocket error:', error);
  }

  // 广播辅助函数
  async broadcast(payload) {
    const sockets = this.ctx.getWebSockets();
    const messageStr = JSON.stringify(payload);
    for (const socket of sockets) {
      try {
        socket.send(messageStr);
      } catch (e) {
        // 发送失败（可能连接已断开），忽略
      }
    }
  }
}