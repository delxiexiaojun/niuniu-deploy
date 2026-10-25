/*
 * 牛牛服务器：HTTP /health + WebSocket 房间协议。
 * 房间权威逻辑在 server/rooms.js（内部跑 js/game.js 的 HostEngine）。
 *
 * 客户端 -> 服务端：create / join / leave / ready / start / rob / bet / reveal / restart / ping
 * 服务端 -> 客户端：created / joined / state / error / room-closed / pong
 */
'use strict';

const http = require('http');
const { attachWebSocket } = require('./ws.js');
const { RoomManager } = require('./rooms.js');

const PORT = Number(process.env.PORT) || 8787;
const SWEEP_MS = 1000;
const HEARTBEAT_MS = 30 * 1000;
const ACTIONS = ['ready', 'start', 'rob', 'bet', 'reveal', 'restart'];

function createGameServer(options) {
  const opts = options || {};
  const clients = new Set();

  function send(conn, msg) {
    if (!conn) return;
    try { conn.send(JSON.stringify(msg)); } catch (e) { /* 忽略 */ }
  }

  function broadcast(room) {
    room.members.forEach((conn, seat) => {
      send(conn, { t: 'state', view: manager.view(room, seat) });
    });
  }

  const manager = new RoomManager({
    closeIdleMs: opts.closeIdleMs,
    emptyRoomMs: opts.emptyRoomMs,
    engineOptions: opts.engineOptions || {},
    onUpdate: broadcast,
    onClose: (room, reason, members) => {
      (members || []).forEach((conn) => {
        send(conn, { t: 'room-closed', reason: reason });
        setTimeout(() => { try { conn.close(); } catch (e) { /* 忽略 */ } }, 300);
      });
    }
  });

  function detach(ws) {
    const roomId = ws.roomId;
    const seat = ws.seat;
    ws.roomId = null;
    ws.seat = null;
    if (roomId === null || seat === null) return;
    manager.detach(roomId, seat, ws);
  }

  function bind(ws, roomId, seat) {
    if (ws.roomId !== null) detach(ws);
    const result = manager.attach(roomId, seat, ws);
    if (!result.ok) return false;
    ws.roomId = roomId;
    ws.seat = seat;
    // 同一座位被新连接接管：换绑已完成，再关旧连接（旧连接的 close 事件会被成员守卫忽略）
    if (result.previous && result.previous !== ws) {
      try { result.previous.close(); } catch (e) { /* 忽略 */ }
    }
    return true;
  }

  function fail(ws, msg, text) {
    send(ws, { t: 'error', message: text, reqId: msg && msg.reqId });
  }

  function handle(ws, msg) {
    if (msg.t === 'ping') {
      send(ws, { t: 'pong' });
      return;
    }

    if (msg.t === 'create') {
      if (ws.roomId !== null) { fail(ws, msg, '已在房间中'); return; }
      const result = manager.create({ name: msg.name, rounds: msg.rounds, players: msg.players });
      if (!result.ok) { fail(ws, msg, result.error); return; }
      bind(ws, result.roomId, result.seat);
      send(ws, {
        t: 'created', reqId: msg.reqId,
        roomId: result.roomId, seat: result.seat, token: result.token
      });
      const room = manager.rooms.get(result.roomId);
      if (room) broadcast(room);
      return;
    }

    if (msg.t === 'join') {
      const result = manager.join(msg.roomId, msg.name, msg.token);
      if (!result.ok) { fail(ws, msg, result.error); return; }
      if (!bind(ws, result.roomId, result.seat)) { fail(ws, msg, '房间不存在或已关闭'); return; }
      send(ws, {
        t: 'joined', reqId: msg.reqId,
        roomId: result.roomId, seat: result.seat, token: result.token, restored: result.restored
      });
      const room = manager.rooms.get(result.roomId);
      if (room) broadcast(room);
      return;
    }

    if (ws.roomId === null) { fail(ws, msg, '尚未进入房间'); return; }

    if (msg.t === 'leave') { detach(ws); return; }

    if (ACTIONS.indexOf(msg.t) !== -1) {
      const room = manager.rooms.get(ws.roomId);
      if (!room || room.members.get(ws.seat) !== ws) { fail(ws, msg, '连接已失效，请重新进房'); return; }
      const result = manager.action(ws.roomId, ws.seat, msg);
      if (!result.ok && !result.ignored && result.error) fail(ws, msg, result.error);
      return;
    }

    fail(ws, msg, '未知消息类型：' + msg.t);
  }

  const server = http.createServer((req, res) => {
    if (req.url === '/health' || req.url === '/') {
      res.writeHead(200, {
        'content-type': 'text/plain; charset=utf-8',
        'access-control-allow-origin': '*',
        'cache-control': 'no-store'
      });
      res.end('ok');
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  });

  attachWebSocket(server, (ws) => {
    ws.roomId = null;
    ws.seat = null;
    ws.alive = true;
    clients.add(ws);
    ws.onPong = () => { ws.alive = true; };
    ws.onMessage = (text) => {
      let msg = null;
      try { msg = JSON.parse(text); } catch (e) { /* 非法 JSON */ }
      if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') {
        send(ws, { t: 'error', message: '消息格式错误' });
        return;
      }
      try {
        handle(ws, msg);
      } catch (err) {
        console.error('[handle]', err);
        send(ws, { t: 'error', message: '服务器处理异常', reqId: msg.reqId });
      }
    };
    ws.onClose = () => {
      clients.delete(ws);
      detach(ws);
    };
  });

  const sweeper = setInterval(() => {
    try { manager.sweep(); } catch (e) { console.error('[sweep]', e); }
  }, opts.sweepMs || SWEEP_MS);
  const heartbeat = setInterval(() => {
    clients.forEach((ws) => {
      if (ws.closed) { clients.delete(ws); return; }
      if (!ws.alive) { try { ws.close(); } catch (e) { /* 忽略 */ } return; }
      ws.alive = false;
      try { ws.ping(); } catch (e) { /* 忽略 */ }
    });
  }, HEARTBEAT_MS);

  server.on('close', () => {
    clearInterval(sweeper);
    clearInterval(heartbeat);
    manager.closeAll('shutdown');
  });

  return { server, manager, clients };
}

if (require.main === module) {
  const { server } = createGameServer();
  server.listen(PORT, '0.0.0.0', () => {
    console.log('niuniu server listening on :' + PORT);
  });
}

module.exports = { createGameServer };
