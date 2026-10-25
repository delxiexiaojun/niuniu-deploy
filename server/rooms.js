/*
 * 服务器托管房间管理。
 * 每个房间跑一个 HostEngine（权威洗牌 / 判定 / 结算），玩家的浏览器只是普通客户端：
 * 创建者退出或掉线只是少一个座位，房间由服务器继续托管。
 *
 * 规则：
 * - 房间创建后 10 分钟内没有任何一局开局 → 自动关闭（唯一的产品级关房规则）
 * - 从未开局的 10 分钟内若已有「准备满 2 人、等待自动开局」的倒计时，则等这局开起来再判断
 * - 房间内 0 个在线连接持续 60 秒 → 回收（技术性清理，避免免费实例内存泄漏）
 * - 玩家断线保留座位与 token 等待重连，但会撤回其准备状态
 *
 * 时钟通过 options.now 注入，单测可直接拨表验证关房时机。
 */
'use strict';

const { HostEngine } = require('../js/game.js');

const CLOSE_IDLE_MS = 10 * 60 * 1000; // 创建后 10 分钟无人开局关房
const EMPTY_ROOM_MS = 60 * 1000;   // 全房间无在线连接 60 秒回收
const MAX_ROOMS = 200;

class RoomManager {
  constructor(options) {
    const opts = options || {};
    this.now = opts.now || (() => Date.now());
    this.closeIdleMs = opts.closeIdleMs !== undefined ? opts.closeIdleMs : CLOSE_IDLE_MS;
    this.emptyRoomMs = opts.emptyRoomMs !== undefined ? opts.emptyRoomMs : EMPTY_ROOM_MS;
    this.maxRooms = opts.maxRooms !== undefined ? opts.maxRooms : MAX_ROOMS;
    this.engineOptions = opts.engineOptions || {};
    this.rooms = new Map();
    this.onUpdate = opts.onUpdate || function () {};
    this.onClose = opts.onClose || function () {};
  }

  _newId() {
    for (let i = 0; i < 50; i++) {
      const id = String(Math.floor(100000 + Math.random() * 900000));
      if (!this.rooms.has(id)) return id;
    }
    throw new Error('房间号分配失败，请重试');
  }

  /** 创建房间：首个玩家（创建者）直接入座；此后房间不依赖这个连接存活 */
  create(params) {
    const p = params || {};
    const name = String(p.name || '').trim().slice(0, 12);
    if (!name) return { ok: false, error: '昵称不能为空' };
    if (this.rooms.size >= this.maxRooms) return { ok: false, error: '服务器房间已满，请稍后再试' };

    let id;
    try { id = this._newId(); } catch (err) { return { ok: false, error: err.message }; }

    const engine = new HostEngine(id, Object.assign({}, this.engineOptions, {
      totalRounds: p.rounds,
      maxPlayers: p.players
    }));
    const room = {
      id,
      engine,
      createdAt: this.now(),
      emptySince: null,
      started: false,
      closed: false,
      members: new Map()   // seat -> 连接对象，由网络层读写
    };
    engine.onUpdate = () => {
      if (room.closed) return;
      if (engine.round > 0) room.started = true;
      this.onUpdate(room);
    };
    this.rooms.set(id, room);

    const joined = engine.join(name, null);
    if (!joined.ok) {
      room.closed = true;
      this.rooms.delete(id);
      engine.dispose();
      return { ok: false, error: joined.error };
    }
    return { ok: true, roomId: id, seat: joined.seat, token: joined.token };
  }

  /** 加入 / 用 token 回原座 */
  join(roomId, name, token) {
    const room = this.rooms.get(String(roomId || ''));
    if (!room || room.closed) return { ok: false, error: '房间不存在或已关闭' };
    const joined = room.engine.join(name, token || null);
    if (!joined.ok) return joined;
    return {
      ok: true,
      roomId: room.id,
      seat: joined.seat,
      token: joined.token,
      restored: !!joined.restored
    };
  }

  /** 把某座位绑定到一条连接。先换绑再关旧连接，避免旧连接 close 事件误标掉线 */
  attach(roomId, seat, conn) {
    const room = this.rooms.get(String(roomId || ''));
    if (!room || room.closed) return { ok: false, error: '房间不存在或已关闭' };
    const previous = room.members.get(seat) || null;
    room.members.set(seat, conn);
    room.emptySince = null;
    room.engine.markConnected(seat, true);
    return { ok: true, previous, room };
  }

  /** 断开某条连接。只有当前绑定的连接才能解绑，防止被新连接取代后误标掉线 */
  detach(roomId, seat, conn) {
    const room = this.rooms.get(String(roomId || ''));
    if (!room || room.closed) return false;
    if (room.members.get(seat) !== conn) return false;
    room.members.delete(seat);
    room.engine.disconnect(seat);
    if (room.members.size === 0) room.emptySince = this.now();
    this.onUpdate(room);
    return true;
  }

  /** 玩家操作：全部复用 HostEngine 的既有方法与 reqId 幂等 */
  action(roomId, seat, msg) {
    const room = this.rooms.get(String(roomId || ''));
    if (!room || room.closed) return { ok: false, error: '房间不存在或已关闭' };
    const engine = room.engine;
    switch (msg && msg.t) {
      case 'ready': return engine.ready(seat, msg.reqId);
      case 'start': return engine.start(seat, msg.reqId);
      case 'rob': return engine.rob(seat, !!msg.want, msg.reqId);
      case 'bet': return engine.bet(seat, msg.mult, msg.reqId);
      case 'reveal': return engine.reveal(seat, msg.mult, msg.reqId);
      case 'restart': return engine.restart(seat, msg.reqId);
      default: return { ok: false, error: '未知操作' };
    }
  }

  /** 某个座位可见的状态：补上「房间还有多少秒自动关闭」 */
  view(room, seat) {
    const view = room.engine.view(seat);
    if (!room.closed && !room.started) {
      view.closeIn = Math.max(0, Math.ceil((room.createdAt + this.closeIdleMs - this.now()) / 1000));
    } else {
      view.closeIn = null;
    }
    return view;
  }

  /** 定时巡检：超过开房时限仍未开局关房 + 空房回收。由服务端每秒调用一次。 */
  sweep(now) {
    const t = now === undefined ? this.now() : now;
    Array.from(this.rooms.values()).forEach((room) => {
      if (room.closed) return;
      if (!room.started && !room.engine.startingSoon() && t - room.createdAt >= this.closeIdleMs) {
        this.close(room.id, 'nobody-started');
        return;
      }
      if (room.members.size === 0) {
        if (room.emptySince == null) room.emptySince = t;
        else if (t - room.emptySince >= this.emptyRoomMs) this.close(room.id, 'empty');
      } else {
        room.emptySince = null;
      }
    });
  }

  /** 关闭并销毁房间，回调里把在线连接踢下线 */
  close(roomId, reason) {
    const room = this.rooms.get(String(roomId || ''));
    if (!room || room.closed) return false;
    room.closed = true;
    this.rooms.delete(room.id);
    const members = Array.from(room.members.values());
    room.members.clear();
    try { room.engine.dispose(); } catch (e) { /* 忽略 */ }
    this.onClose(room, reason || 'closed', members);
    return true;
  }

  closeAll(reason) {
    Array.from(this.rooms.keys()).forEach((id) => this.close(id, reason || 'shutdown'));
  }
}

module.exports = { RoomManager, CLOSE_IDLE_MS, EMPTY_ROOM_MS };
