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

    // WebSocket 连接
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
    this.sessions = new Map();        // clientId -> { ws, username, initialized, lastHeartbeat }
    this.usernames = new Set();
    this.alarmRunning = false;        // 防止重复设置 Alarm
  }

  // 处理 HTTP 请求（检查用户名，同时清理僵尸连接）
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/check' && request.method === 'POST') {
      // 先清理可能存在的僵尸连接（已断开但未触发 close 事件）
      await this.cleanupDeadConnections();

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

    // WebSocket 升级
    const webSocketPair = new WebSocketPair();
    const [client, server] = Object.values(webSocketPair);
    const clientId = crypto.randomUUID();
    this.ctx.acceptWebSocket(server, [clientId]);
    return new Response(null, { status: 101, webSocket: client });
  }

  // 清理已断开的连接（基于 WebSocket.readyState）
  async cleanupDeadConnections() {
    const toRemove = [];
    for (const [clientId, session] of this.sessions.entries()) {
      try {
        // 检查 WebSocket 是否仍然打开 (readyState 1 = OPEN)
        if (session.ws.readyState !== 1) {
          toRemove.push(clientId);
        }
      } catch (e) {
        // 如果访问 readyState 抛出异常，说明连接已无效
        toRemove.push(clientId);
      }
    }

    for (const clientId of toRemove) {
      await this.cleanupClient(clientId, false); // 静默清理，不广播离开消息
    }
  }

  async webSocketOpen(ws) {
    const clientId = this.ctx.getTags(ws)[0];
    this.sessions.set(clientId, { ws, username: null, initialized: false, lastHeartbeat: Date.now() });
    await this.ensureAlarm();
  }

  async webSocketMessage(ws, message) {
    const clientId = this.ctx.getTags(ws)[0];
    const session = this.sessions.get(clientId);
    if (!session) return;

    try {
      const data = JSON.parse(message);

      // 心跳消息
      if (data.type === 'ping') {
        session.lastHeartbeat = Date.now();
        ws.send(JSON.stringify({ type: 'pong' }));
        return;
      }

      // 初始化消息
      if (data.type === 'init') {
        if (session.initialized) {
          ws.send(JSON.stringify({ type: 'error', code: 'ALREADY_INIT', message: '连接已初始化' }));
          return;
        }

        const username = data.username?.trim();
        const nameRegex = /^[a-zA-Z0-9\u4e00-\u9fa5]{2,12}$/;

        if (!username || !nameRegex.test(username)) {
          ws.send(JSON.stringify({ type: 'error', code: 'INVALID_NAME', message: '用户名必须为2-12位中英文或数字' }));
          ws.close(1000, 'Invalid username');
          return;
        }

        // 再次检查用户名是否已被占用（防止 race condition）
        if (this.usernames.has(username)) {
          ws.send(JSON.stringify({ type: 'error', code: 'DUPLICATE_NAME', message: '用户名已被占用' }));
          ws.close(1000, 'Duplicate username');
          return;
        }

        session.username = username;
        session.initialized = true;
        this.usernames.add(username);

        ws.send(JSON.stringify({ type: 'system', content: `🎉 欢迎 ${username} 加入房间`, timestamp: Date.now() }));

        await this.broadcast({
          type: 'system',
          content: `👋 ${username} 加入了房间`,
          timestamp: Date.now()
        }, clientId);

        // 房间有人，取消可能存在的自动销毁 Alarm（但保留心跳检查 Alarm）
        return;
      }

      // 聊天消息
      if (data.type === 'message') {
        if (!session.initialized) {
          ws.send(JSON.stringify({ type: 'error', code: 'NOT_INIT', message: '请先设置用户名' }));
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
        await this.broadcast(payload);
      }
    } catch (e) {
      console.error('消息处理错误:', e);
    }
  }

  async webSocketClose(ws, code, reason, wasClean) {
    const clientId = this.ctx.getTags(ws)[0];
    await this.cleanupClient(clientId, true);
  }

  async webSocketError(ws, error) {
    const clientId = this.ctx.getTags(ws)[0];
    console.error('WebSocket error for', clientId, error);
    await this.cleanupClient(clientId, true);
  }

  // 清理单个客户端
  async cleanupClient(clientId, broadcastLeave = true) {
    const session = this.sessions.get(clientId);
    if (!session) return;

    const { username, initialized } = session;
    this.sessions.delete(clientId);
    if (initialized && username) {
      this.usernames.delete(username);
      if (broadcastLeave) {
        await this.broadcast({
          type: 'system',
          content: `🚪 ${username} 离开了房间`,
          timestamp: Date.now()
        });
      }
    }

    // 如果房间空了，设置 30 秒后自动销毁（注意：此时应取消心跳 Alarm，改用销毁 Alarm）
    if (this.sessions.size === 0) {
      await this.state.storage.deleteAlarm(); // 清除现有 Alarm
      await this.state.storage.setAlarm(Date.now() + 30000); // 30 秒后销毁
      this.alarmRunning = false;
    }
  }

  // 确保心跳检查 Alarm 在运行
  async ensureAlarm() {
    if (this.sessions.size > 0) {
      const existing = await this.state.storage.getAlarm();
      if (!existing) {
        await this.state.storage.setAlarm(Date.now() + 25000); // 25 秒后检查心跳
        this.alarmRunning = true;
      }
    }
  }

  async alarm() {
    const now = Date.now();
    const heartbeatTimeout = 20000; // 20 秒无心跳视为断开

    // 检查心跳超时的连接
    const toRemove = [];
    for (const [clientId, session] of this.sessions.entries()) {
      if (now - session.lastHeartbeat > heartbeatTimeout) {
        toRemove.push(clientId);
      }
    }

    for (const clientId of toRemove) {
      const session = this.sessions.get(clientId);
      if (session) {
        try {
          session.ws.close(1001, 'Heartbeat timeout');
        } catch (e) {}
        await this.cleanupClient(clientId, true);
      }
    }

    // 如果房间仍有人，继续下一次心跳检查；否则设置销毁 Alarm
    if (this.sessions.size > 0) {
      await this.state.storage.setAlarm(Date.now() + 25000);
    } else {
      // 房间无人，设置 30 秒后销毁（与 cleanupClient 中逻辑一致）
      await this.state.storage.setAlarm(Date.now() + 30000);
    }
  }

  async broadcast(payload, excludeClientId = null) {
    const messageStr = JSON.stringify(payload);
    for (const [cid, session] of this.sessions.entries()) {
      if (cid === excludeClientId) continue;
      if (!session.initialized) continue;
      try {
        session.ws.send(messageStr);
      } catch (e) {}
    }
  }
}