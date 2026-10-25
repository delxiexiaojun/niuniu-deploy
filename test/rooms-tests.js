/*
 * 房间管理单测（不依赖网络）：
 *   node test/rooms-tests.js
 * 重点验证：10 分钟无人开局自动关房 / 开局后不关房 / 创建者掉线房间仍能开局 /
 *          token 重连回原座 / 空房回收 / 断线撤回准备 / 连接换绑守卫。
 */
'use strict';

const assert = require('assert');
const { RoomManager } = require('../server/rooms.js');

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('  PASS  ' + name);
  } catch (err) {
    failures.push({ name, err });
    console.error('  FAIL  ' + name);
    console.error(err && err.stack ? err.stack.split('\n').slice(0, 6).join('\n') : err);
  }
}

const clock = { t: 1000000 };
const now = () => clock.t;

function setup(overrides) {
  clock.t = 1000000;
  const events = { updates: 0, closes: [] };
  const manager = new RoomManager(Object.assign({
    now,
    engineOptions: { readyDelaySeconds: 0, robSeconds: 0, revealSeconds: 0 },
    onUpdate: () => { events.updates += 1; },
    onClose: (room, reason) => { events.closes.push({ roomId: room.id, reason }); }
  }, overrides || {}));
  return { manager, events };
}

const fakeConn = (label) => ({ label, closed: false, close() { this.closed = true; } });

test('创建房间：6 位房间号 + 首座位 + closeIn=600', () => {
  const { manager } = setup();
  const created = manager.create({ name: '创建者', rounds: 12, players: 4 });
  assert.strictEqual(created.ok, true);
  assert.ok(/^\d{6}$/.test(created.roomId));
  assert.strictEqual(created.seat, 0);
  const room = manager.rooms.get(created.roomId);
  assert.ok(room);
  assert.strictEqual(manager.view(room, 0).closeIn, 600);
});

test('10 分钟无人开局：自动关房并通知 onClose', () => {
  const { manager, events } = setup();
  const created = manager.create({ name: 'A', rounds: 12, players: 4 });
  const conn = fakeConn('a');
  manager.attach(created.roomId, created.seat, conn);

  clock.t = 1000000 + 599000;
  manager.sweep();
  assert.ok(manager.rooms.has(created.roomId), '差 1 秒时房间还在');
  assert.strictEqual(manager.view(manager.rooms.get(created.roomId), 0).closeIn, 1);

  clock.t = 1000000 + 600000;
  manager.sweep();
  assert.strictEqual(manager.rooms.has(created.roomId), false);
  assert.deepStrictEqual(events.closes, [{ roomId: created.roomId, reason: 'nobody-started' }]);
});

test('有人准备并开局后：超过 10 分钟也不关房', () => {
  const { manager, events } = setup();
  const created = manager.create({ name: 'A', rounds: 12, players: 4 });
  const b = manager.join(created.roomId, 'B', null);
  assert.strictEqual(b.ok, true);
  manager.attach(created.roomId, created.seat, fakeConn('a'));
  manager.attach(created.roomId, b.seat, fakeConn('b'));

  manager.action(created.roomId, created.seat, { t: 'ready', reqId: 'r1' });
  manager.action(created.roomId, b.seat, { t: 'ready', reqId: 'r2' });
  const room = manager.rooms.get(created.roomId);
  assert.strictEqual(room.engine.round, 1, '2 人准备后应立即开局');

  manager.sweep(1000000 + 700000);
  assert.ok(manager.rooms.has(created.roomId), '已开局房间不应被关房规则关掉');
  assert.strictEqual(events.closes.length, 0);
});

test('关房不抢在「准备满 2 人、等待自动开局」倒计时前面', () => {
  const { manager } = setup({ engineOptions: { readyDelaySeconds: 5, robSeconds: 0, revealSeconds: 0 } });
  const created = manager.create({ name: 'A', rounds: 12, players: 4 });
  const b = manager.join(created.roomId, 'B', null);
  manager.attach(created.roomId, created.seat, fakeConn('a'));
  manager.attach(created.roomId, b.seat, fakeConn('b'));

  clock.t = 1000000 + 597000;
  manager.action(created.roomId, created.seat, { t: 'ready', reqId: 'r1' });
  manager.action(created.roomId, b.seat, { t: 'ready', reqId: 'r2' });

  manager.sweep(1000000 + 600000);
  assert.ok(manager.rooms.has(created.roomId), '自动开局倒计时中不应关房');

  // 倒计时结束后正常开局，之后也不会关房
  const room = manager.rooms.get(created.roomId);
  room.engine.start(room.engine.hostSeat, 'auto-finish');
  assert.strictEqual(room.engine.round, 1);
  manager.sweep(1000000 + 900000);
  assert.ok(manager.rooms.has(created.roomId));
});

test('创建者掉线后，剩下 2 人准备仍能正常开局（房间不再依赖创建者）', () => {
  const { manager } = setup();
  const created = manager.create({ name: '创建者', rounds: 12, players: 4 });
  const b = manager.join(created.roomId, 'B', null);
  const c = manager.join(created.roomId, 'C', null);
  const ca = fakeConn('a');
  manager.attach(created.roomId, created.seat, ca);
  manager.attach(created.roomId, b.seat, fakeConn('b'));
  manager.attach(created.roomId, c.seat, fakeConn('c'));

  // 创建者关页面
  manager.detach(created.roomId, created.seat, ca);
  const room = manager.rooms.get(created.roomId);
  assert.strictEqual(room.engine.seats[created.seat].connected, false);
  assert.ok(room.engine.seats[created.seat], '座位与 token 仍保留等待重连');

  manager.action(created.roomId, b.seat, { t: 'ready', reqId: 'rb' });
  manager.action(created.roomId, c.seat, { t: 'ready', reqId: 'rc' });
  assert.strictEqual(room.engine.round, 1, '创建者掉线不应阻止开局');
  assert.deepStrictEqual(room.engine.roundSeats, [b.seat, c.seat]);
});

test('token 重连回到原座位并恢复在线', () => {
  const { manager } = setup();
  const created = manager.create({ name: 'A', rounds: 12, players: 4 });
  const b = manager.join(created.roomId, 'B', null);
  const cb = fakeConn('b');
  manager.attach(created.roomId, b.seat, cb);
  manager.detach(created.roomId, b.seat, cb);

  const again = manager.join(created.roomId, 'B', b.token);
  assert.strictEqual(again.ok, true);
  assert.strictEqual(again.restored, true);
  assert.strictEqual(again.seat, b.seat);
  assert.strictEqual(manager.rooms.get(created.roomId).engine.seats[b.seat].connected, true);
});

test('断线撤回准备状态，避免掉线玩家拖住自动开局', () => {
  const { manager } = setup({ engineOptions: { readyDelaySeconds: 30, robSeconds: 0, revealSeconds: 0 } });
  const created = manager.create({ name: 'A', rounds: 12, players: 4 });
  const b = manager.join(created.roomId, 'B', null);
  const ca = fakeConn('a');
  manager.attach(created.roomId, created.seat, ca);
  manager.attach(created.roomId, b.seat, fakeConn('b'));

  manager.action(created.roomId, created.seat, { t: 'ready', reqId: 'r1' });
  manager.detach(created.roomId, created.seat, ca);
  const room = manager.rooms.get(created.roomId);
  assert.strictEqual(room.engine.readySet.has(created.seat), false);
  assert.strictEqual(room.engine.seats[created.seat].connected, false);
});

test('局中不允许新玩家加入', () => {
  const { manager } = setup();
  const created = manager.create({ name: 'A', rounds: 12, players: 4 });
  const b = manager.join(created.roomId, 'B', null);
  manager.attach(created.roomId, created.seat, fakeConn('a'));
  manager.attach(created.roomId, b.seat, fakeConn('b'));
  manager.action(created.roomId, created.seat, { t: 'ready', reqId: 'r1' });
  manager.action(created.roomId, b.seat, { t: 'ready', reqId: 'r2' });

  const c = manager.join(created.roomId, 'C', null);
  assert.strictEqual(c.ok, false);
  assert.ok(/本局进行中/.test(c.error));
});

test('同房间昵称唯一（忽略大小写）', () => {
  const { manager } = setup();
  const created = manager.create({ name: 'Alice', rounds: 12, players: 4 });
  const dup = manager.join(created.roomId, 'alice', null);
  assert.strictEqual(dup.ok, false);
  assert.ok(/已被占用/.test(dup.error));
});

test('座位被新连接接管后，旧连接断开不会误标掉线', () => {
  const { manager } = setup();
  const created = manager.create({ name: 'A', rounds: 12, players: 4 });
  const oldConn = fakeConn('old');
  const newConn = fakeConn('new');
  const first = manager.attach(created.roomId, created.seat, oldConn);
  assert.strictEqual(first.previous, null);
  const second = manager.attach(created.roomId, created.seat, newConn);
  assert.strictEqual(second.previous, oldConn);

  // 旧连接迟到触发的解绑应被忽略
  assert.strictEqual(manager.detach(created.roomId, created.seat, oldConn), false);
  assert.strictEqual(manager.rooms.get(created.roomId).engine.seats[created.seat].connected, true);
});

test('空房回收：无在线连接 60 秒后销毁', () => {
  const { manager, events } = setup({ closeIdleMs: 300000, emptyRoomMs: 60000 });
  const created = manager.create({ name: 'A', rounds: 12, players: 4 });
  const conn = fakeConn('a');
  manager.attach(created.roomId, created.seat, conn);
  manager.detach(created.roomId, created.seat, conn);

  manager.sweep(1000000 + 59000);
  assert.ok(manager.rooms.has(created.roomId));
  manager.sweep(1000000 + 60000);
  assert.strictEqual(manager.rooms.has(created.roomId), false);
  assert.strictEqual(events.closes[0].reason, 'empty');
});

test('重新开始后不再触发创建时的关房规则', () => {
  const { manager } = setup();
  const created = manager.create({ name: 'A', rounds: 1, players: 4 });
  const b = manager.join(created.roomId, 'B', null);
  manager.attach(created.roomId, created.seat, fakeConn('a'));
  manager.attach(created.roomId, b.seat, fakeConn('b'));

  manager.action(created.roomId, created.seat, { t: 'ready', reqId: 'r1' });
  manager.action(created.roomId, b.seat, { t: 'ready', reqId: 'r2' });
  const room = manager.rooms.get(created.roomId);
  // 1 局打完（超时路径直接结算），进入 finished
  room.engine.start(room.engine.hostSeat, 'force');
  room.engine._finishRobbing();
  room.engine._finishBetting();
  room.engine._finishRevealing();
  assert.strictEqual(room.engine.phase, 'finished');

  manager.action(created.roomId, created.seat, { t: 'restart', reqId: 'rs' });
  assert.strictEqual(room.engine.round, 0);
  assert.strictEqual(manager.view(room, 0).closeIn, null, '重新开始后不再显示关房倒计时');
  manager.sweep(1000000 + 900000);
  assert.ok(manager.rooms.has(created.roomId), '重新开始后的房间不应被关房规则关掉');
});

console.log('\n房间管理测试：' + passed + ' 通过，' + failures.length + ' 失败');
if (failures.length) {
  failures.forEach((f) => console.error(' - ' + f.name));
  process.exit(1);
}
