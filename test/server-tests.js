/*
 * 服务端端到端测试（使用 Node 22 内置 WebSocket 客户端，无第三方依赖）：
 *   node test/server-tests.js
 * 覆盖：/health、创建/加入/准备/抢庄/下注/亮牌/结算全流程、
 *      创建者断开后房间仍存活并继续开局、token 回座、无人开局自动关房。
 */
'use strict';

const assert = require('assert');
const { createGameServer } = require('../server/index.js');

let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log('  PASS  ' + name);
  } catch (err) {
    failures.push({ name, err });
    console.error('  FAIL  ' + name);
    console.error(err && err.stack ? err.stack.split('\n').slice(0, 6).join('\n') : err);
  }
}

const activeClients = new Set();

function makeClient(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const client = {
      ws,
      queue: [],
      waiters: [],
      send(msg) { ws.send(JSON.stringify(msg)); },
      next(type, timeoutMs) {
        const found = client.queue.findIndex((m) => m.t === type);
        if (found !== -1) return Promise.resolve(client.queue.splice(found, 1)[0]);
        return new Promise((res, rej) => {
          const timer = setTimeout(() => {
            const i = client.waiters.indexOf(entry);
            if (i !== -1) client.waiters.splice(i, 1);
            rej(new Error('等待消息超时：' + type));
          }, timeoutMs || 5000);
          const entry = {
            type,
            resolve: (m) => { clearTimeout(timer); res(m); },
            reject: (e) => { clearTimeout(timer); rej(e); }
          };
          client.waiters.push(entry);
        });
      },
      async waitState(pred, timeoutMs) {
        const deadline = Date.now() + (timeoutMs || 8000);
        while (true) {
          const idx = client.queue.findIndex((m) => m.t === 'state' && (!pred || pred(m.view)));
          if (idx !== -1) return client.queue.splice(idx, 1)[0];
          if (Date.now() > deadline) throw new Error('等待 state 超时');
          await new Promise((r) => setTimeout(r, 30));
        }
      },
      close() { try { ws.close(); } catch (e) { /* 忽略 */ } }
    };
    ws.onmessage = (ev) => {
      let msg = null;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      const idx = client.waiters.findIndex((w) => w.type === msg.t);
      if (idx !== -1) client.waiters.splice(idx, 1)[0].resolve(msg);
      else client.queue.push(msg);
    };
    ws.onopen = () => resolve(client);
    ws.onerror = () => reject(new Error('WebSocket 连接失败'));
    activeClients.add(ws);
  });
}

async function closeAllClients() {
  activeClients.forEach((ws) => { try { ws.close(); } catch (e) { /* 忽略 */ } });
  activeClients.clear();
  await new Promise((r) => setTimeout(r, 50));
}

async function withServer(options, fn) {
  const { server, manager } = createGameServer(options);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const url = 'ws://127.0.0.1:' + port;
  try {
    await fn(url, port, manager);
  } finally {
    manager.closeAll('test-done');
    await closeAllClients();
    try { server.closeAllConnections(); } catch (e) { /* 忽略 */ }
    await new Promise((resolve) => server.close(resolve));
  }
}

(async () => {
  await test('GET /health 返回 ok', async () => {
    await withServer({}, async (url, port) => {
      const res = await fetch('http://127.0.0.1:' + port + '/health');
      assert.strictEqual(res.status, 200);
      assert.strictEqual((await res.text()).trim(), 'ok');
    });
  });

  await test('完整一局：创建→加入→准备→抢庄→下注→亮牌→结算', async () => {
    await withServer({
      engineOptions: { readyDelaySeconds: 0, robSeconds: 0, revealSeconds: 0 },
      closeIdleMs: 1200, sweepMs: 200
    }, async (url, port, manager) => {
      const a = await makeClient(url);
      a.send({ t: 'create', name: 'A', rounds: 12, players: 4, reqId: 'c1' });
      const created = await a.next('created');
      assert.ok(/^\d{6}$/.test(created.roomId));
      assert.strictEqual(created.seat, 0);
      const lobby = await a.waitState((v) => v.phase === 'lobby');
      assert.ok(lobby.view.closeIn > 0 && lobby.view.closeIn <= 2, '应下发 closeIn 倒计时');

      const b = await makeClient(url);
      b.send({ t: 'join', roomId: created.roomId, name: 'B', reqId: 'j1' });
      const joined = await b.next('joined');
      assert.strictEqual(joined.seat, 1);
      await b.waitState((v) => v.seats.filter(Boolean).length === 2);

      a.send({ t: 'ready', reqId: 'ra' });
      b.send({ t: 'ready', reqId: 'rb' });
      const robbing = await a.waitState((v) => v.phase === 'robbing');
      assert.strictEqual(robbing.view.round, 1);

      a.send({ t: 'rob', want: true, reqId: 'roba' });
      b.send({ t: 'rob', want: false, reqId: 'robb' });
      const betting = await a.waitState((v) => v.phase === 'betting');
      assert.strictEqual(betting.view.bankerSeat, created.seat, '唯一抢庄者应成为庄家');

      b.send({ t: 'bet', mult: 8, reqId: 'betb' });
      const revealing = await b.waitState((v) => v.phase === 'revealing');
      assert.strictEqual(revealing.view.seats[created.seat].revealed, true, '庄家定庄即自动亮牌');

      b.send({ t: 'reveal', reqId: 'revb' });
      const settled = await a.waitState((v) => v.phase === 'settled');
      assert.ok(settled.view.result && settled.view.result.ranking.length === 2);
      assert.ok(settled.view.hands, '结算后公开所有牌面');

      // 等到超过原来的 1.2 秒关房窗口：已开局房间不应被关
      await new Promise((r) => setTimeout(r, 1600));
      assert.strictEqual(manager.rooms.size, 1, '房间仍存在');
    });
  });

  await test('创建者断开后房间存活，剩余玩家继续开局', async () => {
    const { server, manager } = createGameServer({
      engineOptions: { readyDelaySeconds: 0, robSeconds: 0, revealSeconds: 0 },
      closeIdleMs: 1500, sweepMs: 200
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const url = 'ws://127.0.0.1:' + port;
    try {
      const a = await makeClient(url);
      a.send({ t: 'create', name: '创建者', rounds: 12, players: 4, reqId: 'c1' });
      const created = await a.next('created');
      const b = await makeClient(url);
      b.send({ t: 'join', roomId: created.roomId, name: 'B', reqId: 'j1' });
      await b.next('joined');

      a.close(); // 创建者直接关页面 / 掉线
      const off = await b.waitState((v) => v.seats[0] && v.seats[0].connected === false);
      assert.strictEqual(off.view.phase, 'lobby');

      // 房间还在，新玩家可以加入并和 B 一起准备开局
      const c = await makeClient(url);
      c.send({ t: 'join', roomId: created.roomId, name: 'C', reqId: 'j2' });
      const joinedC = await c.next('joined');
      assert.strictEqual(joinedC.ok, undefined);
      b.send({ t: 'ready', reqId: 'rb' });
      c.send({ t: 'ready', reqId: 'rc' });
      const robbing = await b.waitState((v) => v.phase === 'robbing', 5000);
      assert.deepStrictEqual(robbing.view.roundSeats, [1, 2], '掉线的创建者不参与本局');
      assert.strictEqual(robbing.view.seats[0].connected, false);
    } finally {
      manager.closeAll('test-done');
      await closeAllClients();
      try { server.closeAllConnections(); } catch (e) { /* 忽略 */ }
      await new Promise((resolve) => server.close(resolve));
    }
  });

  await test('token 重连回到原座位', async () => {
    await withServer({ engineOptions: { readyDelaySeconds: 0, robSeconds: 0, revealSeconds: 0 } }, async (url) => {
      const a = await makeClient(url);
      a.send({ t: 'create', name: 'A', rounds: 12, players: 4, reqId: 'c1' });
      const created = await a.next('created');
      const b = await makeClient(url);
      b.send({ t: 'join', roomId: created.roomId, name: 'B', reqId: 'j1' });
      const joined = await b.next('joined');

      b.close();
      await a.waitState((v) => v.seats[1] && v.seats[1].connected === false);

      const b2 = await makeClient(url);
      b2.send({ t: 'join', roomId: created.roomId, name: 'B', token: joined.token, reqId: 'j2' });
      const again = await b2.next('joined');
      assert.strictEqual(again.seat, joined.seat);
      assert.strictEqual(again.restored, true);
      await a.waitState((v) => v.seats[1] && v.seats[1].connected === true);
    });
  });

  await test('无人开局自动关房并下发 room-closed', async () => {
    await withServer({
      closeIdleMs: 1200,
      sweepMs: 200,
      engineOptions: { readyDelaySeconds: 0, robSeconds: 0, revealSeconds: 0 }
    }, async (url) => {
      const a = await makeClient(url);
      a.send({ t: 'create', name: 'A', rounds: 12, players: 4, reqId: 'c1' });
      const created = await a.next('created');
      const closed = await a.next('room-closed', 5000);
      assert.strictEqual(closed.reason, 'nobody-started');

      const b = await makeClient(url);
      b.send({ t: 'join', roomId: created.roomId, name: 'B', reqId: 'j1' });
      const err = await b.next('error');
      assert.ok(/房间不存在或已关闭/.test(err.message));
    });
  });

  console.log('\n服务端集成测试：' + passed + ' 通过，' + failures.length + ' 失败');
  if (failures.length) {
    failures.forEach((f) => console.error(' - ' + f.name));
    process.exit(1);
  }
})();
