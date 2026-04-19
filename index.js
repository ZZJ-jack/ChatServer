// src/index.js

// --- Worker 入口逻辑 ---
export default {
  async fetch(request, env) {
    // 1. 解析请求 URL，获取房间名称
    const url = new URL(request.url);
    const pathSegments = url.pathname.split('/').filter(Boolean);

    // 期望的路径格式：/room/:roomName
    if (pathSegments.length === 0 || pathSegments[0] !== 'room') {
      return new Response('Not Found. Please connect to /room/:roomName', { status: 404 });
    }

    const roomName = pathSegments[1] || 'default-room';

    // 2. 检查是否为 WebSocket 升级请求
    if (request.headers.get('Upgrade') !== 'websocket') {
      // 如果只是普通 HTTP 请求，返回简单的 HTML 页面，方便测试
      return new Response(
        `<html>
          <body>
            <h1>Cloudflare Chat Room: ${roomName}</h1>
            <p>Connect via WebSocket to: wss://${url.host}/room/${roomName}</p>
            <p>You can use the browser console or a WebSocket client to connect.</p>
            <script>
              // 一个非常简单的浏览器内测试客户端
              const room = '${roomName}';
              const ws = new WebSocket(\`wss://\${location.host}/room/\${room}\`);
              ws.onopen = () => console.log('Connected!');
              ws.onmessage = (e) => console.log('Received:', e.data);
              ws.onclose = () => console.log('Disconnected');
              window.send = (msg) => ws.send(msg);
              console.log('Use send("your message") to chat.');
            </script>
          </body>
        </html>`,
        { headers: { 'Content-Type': 'text/html' } }
      );
    }

    // 3. 处理 WebSocket 升级请求
    // 获取 Durable Object 的 ID（每个房间名对应一个唯一的 ID）
    const id = env.CHAT_ROOM.idFromName(roomName);
    // 获取该 ID 对应的 Durable Object 存根
    const roomObject = env.CHAT_ROOM.get(id);

    // 将请求转发给 Durable Object 的 fetch 方法处理
    return roomObject.fetch(request);
  },
};

// --- Durable Object 类：ChatRoom ---
export class ChatRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    // 使用 this.ctx 访问 WebSocket Hibernation API
    this.ctx = state; 
    // 存储 WebSocket 连接信息，用于休眠/唤醒时的状态管理
    this.sessions = new Map();
  }

  async fetch(request) {
    // 从请求中提取 WebSocket
    const webSocketPair = new WebSocketPair();
    const [client, server] = Object.values(webSocketPair);

    // 为该连接生成唯一的客户端 ID
    const clientId = crypto.randomUUID();
    
    // 使用 Hibernation API 接受 WebSocket 连接
    this.ctx.acceptWebSocket(server, [clientId]);

    // 返回 101 Switching Protocols 响应，并带上客户端的 WebSocket
    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  // --- WebSocket Hibernation API 处理函数 ---
  
  // 当新的 WebSocket 连接被 acceptWebSocket 接受时调用
  async webSocketMessage(ws, message) {
    // 获取该连接对应的元数据（客户端 ID）
    const clientId = this.ctx.getTags(ws)[0];
    
    try {
      // 解析客户端发送的消息
      const data = JSON.parse(message);
      const payload = {
        type: data.type || 'message',
        clientId: clientId,
        content: data.content,
        timestamp: Date.now(),
      };

      // 如果是聊天消息，存储到 Durable Object 的持久化存储中
      if (payload.type === 'message') {
        await this.state.storage.put(`msg:${payload.timestamp}`, payload);
      }

      // 将消息广播给房间内所有其他用户
      await this.broadcast(payload);
    } catch (e) {
      console.error('Error processing message:', e);
    }
  }

  // 当 WebSocket 连接关闭时调用
  async webSocketClose(ws, code, reason, wasClean) {
    const clientId = this.ctx.getTags(ws)[0];
    // 广播“用户离开”的系统消息
    const leaveMessage = {
      type: 'system',
      content: `User ${clientId} left the room.`,
      timestamp: Date.now(),
    };
    await this.broadcast(leaveMessage);
  }

  // 当 WebSocket 连接发生错误时调用
  async webSocketError(ws, error) {
    console.error('WebSocket error:', error);
  }

  // --- 辅助函数：广播消息 ---
  async broadcast(payload) {
    // 获取当前 Durable Object 实例管理的所有 WebSocket 连接
    const sockets = this.ctx.getWebSockets();
    
    const messageStr = JSON.stringify(payload);
    
    // 向所有已连接的 WebSocket 发送消息
    for (const socket of sockets) {
      try {
        socket.send(messageStr);
      } catch (e) {
        console.error('Failed to send to socket:', e);
        // 如果发送失败，可以在这里记录并考虑清理连接
      }
    }
  }

  // 注意：我们没有显式定义 webSocketOpen，因为使用了 Hibernation API 后，
  // 连接在休眠唤醒后会自动重建，无需手动管理。
}