/*
 * 传输层（P2P 版）：房主标签页跑 HostEngine 作为权威，其他玩家用 PeerJS 连房主。
 * 对外 API 与服务器版保持一致（connect / send / close / open + onMessage 等），
 * app.js / UI 层不需要区分数据来自服务器还是房主。
 */
(function (root) {
  'use strict';

  const Transport = root.Transport;
  const Game = root.NiuNiuGame;
  const CLOSE_IDLE_MS = 10 * 60 * 1000; // 房主端 10 分钟无人开局自动关房

  const net = {
    open: false,
    onMessage: null,
    onOpen: null,
    onClose: null,
    onStatus: null,
    _role: null,       // 'host' | 'guest' | null
    _peer: null,
    _conn: null,
    _roomId: null,
    _seat: null,
    _room: null,
    _pendingJoin: null,
    _timer: null
  };

  function emit(msg) {
    try { if (net.onMessage) net.onMessage(msg); } catch (e) { console.error(e); }
  }

  function status(text) {
    try { if (net.onStatus) net.onStatus(text); } catch (e) { /* 忽略 */ }
  }

  function sendRaw(conn, msg) {
    try {
      if (conn && conn.open) { conn.send(msg); return true; }
    } catch (e) { /* 忽略 */ }
    return false;
  }

  function failConn(conn, message, reqId) {
    sendRaw(conn, { t: 'error', message: message, reqId: reqId });
  }

  function parse(data) {
    if (typeof data === 'string') {
      try { return JSON.parse(data); } catch (e) { return null; }
    }
    return data && typeof data === 'object' ? data : null;
  }

  function stopTimer() {
    if (net._timer) { clearInterval(net._timer); net._timer = null; }
  }

  function reset() {
    stopTimer();
    net.open = false;
    net._role = null;
    net._peer = null;
    net._conn = null;
    net._roomId = null;
    net._seat = null;
    net._room = null;
    net._pendingJoin = null;
  }

  /* ---------------- 房主端 ---------------- */

  function hostAction(room, seat, msg) {
    const engine = room.engine;
    switch (msg.t) {
      case 'ready': return engine.ready(seat, msg.reqId);
      case 'start': return engine.start(seat, msg.reqId);
      case 'rob': return engine.rob(seat, !!msg.want, msg.reqId);
      case 'bet': return engine.bet(seat, msg.mult, msg.reqId);
      case 'reveal': return engine.reveal(seat, msg.mult, msg.reqId);
      case 'restart': return engine.restart(seat, msg.reqId);
      default: return { ok: false, error: '未知操作' };
    }
  }

  function viewFor(room, seat) {
    const view = room.engine.view(seat);
    view.closeIn = (!room.closed && !room.started)
      ? Math.max(0, Math.ceil((room.createdAt + CLOSE_IDLE_MS - Date.now()) / 1000))
      : null;
    return view;
  }

  function broadcast(room) {
    if (!room || room.closed) return;
    if (room.engine.round > 0) room.started = true;
    room.members.forEach((conn, seat) => {
      sendRaw(conn, { t: 'state', view: viewFor(room, seat) });
    });
    emit({ t: 'state', view: viewFor(room, net._seat) });
  }

  /** 语音留言：房主只做中转，不落库；按发送者座位标注来源，跳过发送者自己的连接 */
  function relayVoice(room, seat, msg, skipConn) {
    if (!room || room.closed) return false;
    const payload = { t: 'voice', seat: seat, data: msg.data, mime: msg.mime, dur: msg.dur };
    room.members.forEach((conn) => {
      if (conn && conn !== skipConn) sendRaw(conn, payload);
    });
    return true;
  }

  function dropGuest(room, conn) {
    if (!room || room.closed) return;
    const seat = conn.seat;
    if (seat === null || seat === undefined) return;
    if (room.members.get(seat) !== conn) return; // 已被新连接接管，忽略旧连接的 close
    room.members.delete(seat);
    try { room.engine.disconnect(seat); } catch (e) { /* 忽略 */ }
    broadcast(room);
  }

  function bindGuest(room, conn) {
    conn.on('data', (data) => {
      const msg = parse(data);
      if (msg) hostHandle(room, conn, msg);
    });
    conn.on('close', () => dropGuest(room, conn));
    conn.on('error', () => dropGuest(room, conn));
  }

  function hostHandle(room, conn, msg) {
    if (room.closed) return;

    if (msg.t === 'ping') { sendRaw(conn, { t: 'pong' }); return; }

    if (msg.t === 'join') {
      const res = room.engine.join(msg.name, msg.token);
      if (!res.ok) { failConn(conn, res.error, msg.reqId); return; }
      if (conn.seat !== null && conn.seat !== undefined && conn.seat !== res.seat) {
        room.members.delete(conn.seat);
      }
      const previous = room.members.get(res.seat);
      room.members.set(res.seat, conn);
      conn.seat = res.seat;
      // 先换绑再关旧连接：close 事件里的成员守卫会忽略旧连接
      if (previous && previous !== conn) {
        try { previous.close(); } catch (e) { /* 忽略 */ }
      }
      sendRaw(conn, {
        t: 'joined', reqId: msg.reqId, roomId: room.id,
        seat: res.seat, token: res.token, restored: res.restored
      });
      broadcast(room);
      return;
    }

    if (conn.seat === null || conn.seat === undefined) {
      failConn(conn, '尚未进入房间', msg.reqId);
      return;
    }

    if (msg.t === 'leave') {
      const seat = conn.seat;
      room.members.delete(seat);
      conn.seat = null;
      try { room.engine.disconnect(seat); } catch (e) { /* 忽略 */ }
      broadcast(room);
      return;
    }

    if (msg.t === 'voice') {
      if (room.members.get(conn.seat) !== conn) return;
      if (typeof msg.data !== 'string' || !msg.data || msg.data.length > 300000) return;
      relayVoice(room, conn.seat, msg, conn);
      // 房主自己也要听到：语音经房主中转，同时投递给本页面播放
      emit({ t: 'voice', seat: conn.seat, data: msg.data, mime: msg.mime, dur: msg.dur });
      return;
    }

    if (['ready', 'start', 'rob', 'bet', 'reveal', 'restart'].indexOf(msg.t) === -1) {
      failConn(conn, '未知消息类型：' + msg.t, msg.reqId);
      return;
    }
    if (room.members.get(conn.seat) !== conn) {
      failConn(conn, '连接已失效，请重新进房', msg.reqId);
      return;
    }
    const result = hostAction(room, conn.seat, msg);
    if (result && !result.ok && !result.ignored && result.error) {
      failConn(conn, result.error, msg.reqId);
    }
  }

  function closeRoom(room, reason, notifySelf) {
    if (!room || room.closed) return;
    room.closed = true;
    room.members.forEach((conn) => {
      sendRaw(conn, { t: 'room-closed', reason: reason });
    });
    try { room.engine.dispose(); } catch (e) { /* 忽略 */ }
    try { if (net._peer) net._peer.destroy(); } catch (e) { /* 忽略 */ }
    const wasSelf = !!notifySelf;
    reset();
    if (wasSelf) emit({ t: 'room-closed', reason: reason });
  }

  function startHost(msg) {
    net._role = 'host';
    status('正在创建房间通道…');

    let attempt = 0;
    const tryCreate = () => {
      attempt += 1;
      const id = String(100000 + Math.floor(Math.random() * 900000));
      Transport.createPeer(Transport.roomPeerId(id)).then((peer) => {
        net._peer = peer;
        net._roomId = id;

        const engine = new Game.HostEngine(id, {
          maxPlayers: msg.players,
          totalRounds: msg.rounds
        });
        const room = {
          id: id, engine: engine, members: new Map(),
          createdAt: Date.now(), started: false, closed: false
        };
        net._room = room;

        const res = engine.join(msg.name);
        if (!res.ok) {
          emit({ t: 'error', message: res.error, reqId: msg.reqId });
          closeRoom(room, 'closed', false);
          return;
        }
        net._seat = res.seat;
        engine.onUpdate = () => broadcast(room);

        peer.on('connection', (conn) => bindGuest(room, conn));
        peer.on('close', () => {
          if (room.closed) return;
          closeRoom(room, 'closed', true);
        });
        net.open = true;

        emit({ t: 'created', reqId: msg.reqId, roomId: id, seat: res.seat, token: res.token });
        broadcast(room);

        stopTimer();
        net._timer = setInterval(() => {
          if (!room || room.closed) return;
          if (!room.started && Date.now() - room.createdAt >= CLOSE_IDLE_MS) {
            closeRoom(room, 'nobody-started', true);
          }
        }, 1000);
      }).catch((err) => {
        if (err && err.type === 'unavailable-id' && attempt < 3) { tryCreate(); return; }
        net._role = null;
        net._roomId = null;
        emit({ t: 'error', message: (err && err.message) || '创建房间失败', reqId: msg.reqId });
      });
    };
    tryCreate();
  }

  /* ---------------- 玩家端 ---------------- */

  function attachGuestConn(conn) {
    net._conn = conn;
    net.open = true;
    conn.on('data', (data) => {
      const msg = parse(data);
      if (msg) emit(msg);
    });
    conn.on('close', () => {
      if (net._conn !== conn) return;
      net.open = false;
      if (net.onClose) { try { net.onClose(); } catch (e) { /* 忽略 */ } }
    });
  }

  /** 把 PeerJS 的原始错误翻译成可判断原因的中文提示 */
  function joinErrText(err) {
    const type = err && err.type ? String(err.type) : '';
    if (type === 'peer-unavailable') return '房间不存在或房主已离线（房主页面可能已关闭或切到后台）';
    if (type === 'network' || type === 'server-error' || type === 'socket-error' || type === 'socket-closed') {
      return '信令服务器连接失败（网络可能拦截了 PeerJS，请切换 Wi-Fi/流量后重试）';
    }
    if (type === 'browser-incompatible') return '当前浏览器不支持 P2P 直连，请换系统浏览器打开';
    if (err && err.message) return err.message;
    return '无法连接房主（未收到具体原因，可能是房主已离线）';
  }

  function startGuest(msg, attempt) {
    const tryNo = attempt || 0;
    net._role = 'guest';
    net._roomId = String(msg.roomId || '');
    net._pendingJoin = msg;
    status(tryNo ? '直连没打通，正在换中继重试…' : '正在连接房主…');

    Transport.createPeer().then((peer) => {
      net._peer = peer;
      return Transport.connectToHost(peer, net._roomId).then((conn) => ({ peer: peer, conn: conn }));
    }).then((res) => {
      attachGuestConn(res.conn);
      const pending = net._pendingJoin;
      net._pendingJoin = null;
      if (pending) {
        Transport.send(res.conn, {
          t: 'join', roomId: net._roomId, name: pending.name,
          token: pending.token || null, reqId: pending.reqId
        });
      }
    }).catch((err) => {
      const pending = net._pendingJoin;
      if (!pending) return;
      // 打洞/中继都超时：销毁旧 peer 重新协商一次，换一组 ICE 候选再试
      if (err && err.retry && tryNo < 1) {
        try { if (net._peer) net._peer.destroy(); } catch (e) { /* 忽略 */ }
        net._peer = null;
        net._pendingJoin = null;
        startGuest(pending, tryNo + 1);
        return;
      }
      net._pendingJoin = null;
      net._role = null;
      net.open = false;
      const reqId = pending.reqId;
      // 最终失败时做一次网络体检，把候选情况写进提示，便于判断是网络拦截还是打洞失败
      const finishErr = (extra) => emit({ t: 'error', message: joinErrText(err) + extra, reqId: reqId });
      if (typeof Transport.probeIce !== 'function') { finishErr(''); return; }
      Transport.probeIce().then((d) => {
        const extra = '（网络体检：直连 ' + d.host + ' / 公网 ' + d.srflx + ' / 中继 ' + d.relay +
          (d.err ? ' / ' + d.err : '') + '）';
        finishErr(extra);
      }).catch(() => finishErr(''));
    });
  }

  /* ---------------- 对外 API ---------------- */

  net.connect = function () {
    if (net.open) return Promise.resolve();
    if (net._role === 'guest' && net._roomId) {
      // 掉线重连：重新用 PeerJS 连房主，成功后由 app 层用 token 静默回座
      status('正在重连房主…');
      return new Promise((resolve, reject) => {
        Transport.createPeer().then((peer) => {
          net._peer = peer;
          return Transport.connectToHost(peer, net._roomId);
        }).then((conn) => {
          attachGuestConn(conn);
          if (net.onOpen) { try { net.onOpen(); } catch (e) { /* 忽略 */ } }
          resolve();
        }).catch((err) => { reject(new Error(joinErrText(err))); });
      });
    }
    // 首次连接：角色由第一条 create / join 消息决定，直接放行
    return Promise.resolve();
  };

  net.send = function (msg) {
    if (!msg) return false;

    if (!net._role) {
      if (msg.t === 'create') { startHost(msg); return true; }
      if (msg.t === 'join') { startGuest(msg); return true; }
      return false;
    }

    if (net._role === 'host') {
      const room = net._room;
      if (!room || room.closed) return false;
      if (msg.t === 'ping') return true;
      if (msg.t === 'voice') {
        relayVoice(room, net._seat, msg, null);
        return true;
      }
      if (msg.t === 'leave') {
        closeRoom(room, 'closed', false);
        return true;
      }
      const result = hostAction(room, net._seat, msg);
      if (result && !result.ok && !result.ignored && result.error && msg.reqId) {
        emit({ t: 'error', message: result.error, reqId: msg.reqId });
      }
      return true;
    }

    return sendRaw(net._conn, msg);
  };

  net.close = function () {
    if (net._role === 'host' && net._room) {
      closeRoom(net._room, 'closed', false);
      return;
    }
    if (net._conn) {
      sendRaw(net._conn, { t: 'leave' });
      try { net._conn.close(); } catch (e) { /* 忽略 */ }
    }
    try { if (net._peer) net._peer.destroy(); } catch (e) { /* 忽略 */ }
    reset();
  };

  root.NiuNiuNet = net;
})(typeof globalThis !== 'undefined' ? globalThis : this);
