/*
 * 最小验收测试（无第三方依赖）：
 *   node test/run-tests.js
 * 覆盖：evaluateHand 纯函数 / 牌型与比牌 / 抢庄流程与定庄范围 / 阶段超时兜底 /
 *       手牌隐私 / 座位与 token 重连 / 请求幂等 / 庄闲结算守恒。
 */
'use strict';

const assert = require('assert');
const E = require('../js/evaluator.js');
const { HostEngine } = require('../js/game.js');

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
    console.error(err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n') : err);
  }
}

const card = (rank, suit) => ({ rank, suit });

// 测试中默认关闭真实定时器（秒数=0），超时路径直接调 _finishXxx 验证
function setup(playerCount) {
  const engine = new HostEngine('100001', { robSeconds: 0, revealSeconds: 0 });
  const players = [engine.join('房主')];
  for (let i = 1; i < playerCount; i++) players.push(engine.join('玩家' + (i + 1)));
  return { engine, players };
}

/** 全员抢庄：choices[i] 为 true 表示抢。必须在 robbing 阶段调用。 */
function robAll(engine, table, choices) {
  table.forEach((p, index) => {
    const want = choices ? choices[index] : false;
    const result = engine.rob(p.seat, want, 'rob-r' + engine.round + '-' + index);
    assert.strictEqual(result.ok, true);
  });
}

/** 全部闲家亮牌（庄家已自动亮牌）。 */
function revealAll(engine, table, mults) {
  table.forEach((p, index) => {
    if (p.seat === engine.bankerSeat) return;
    const result = engine.reveal(p.seat, mults ? mults[index] : 5, 'reveal-r' + engine.round + '-' + index);
    assert.strictEqual(result.ok, true);
  });
}

/** 快速打完一局：抢庄选择 + 亮牌倍数（按 players 下标给）。 */
function playRound(engine, players, choices, mults) {
  assert.strictEqual(engine.start(0, 'start-' + engine.round).ok, true);
  robAll(engine, players, choices);
  assert.strictEqual(engine.phase, 'revealing');
  revealAll(engine, players, mults);
  assert.ok(engine.phase === 'settled' || engine.phase === 'finished', '应进入结算/结束阶段，实际 ' + engine.phase);
}

console.log('\n[evaluator]');

test('牛牛：三张凑 30，余下 K+10 为 20', () => {
  const res = E.evaluateHand([card('10', '♠'), card('J', '♥'), card('Q', '♦'), card('K', '♣'), card('10', '♥')]);
  assert.strictEqual(res.niu, 10);
  assert.strictEqual(res.label, '牛牛');
  assert.deepStrictEqual(res.maxCard, { rank: 'K', suit: '♣' });
});

test('牛五：A+4+5 凑 10，剩 2+3=5', () => {
  const res = E.evaluateHand([card('A', '♠'), card('2', '♥'), card('3', '♦'), card('4', '♣'), card('5', '♠')]);
  assert.strictEqual(res.niu, 5);
  assert.strictEqual(res.label, '牛五');
});

test('无牛：A 2 4 6 9 没有任何三张凑 10 的倍数', () => {
  const res = E.evaluateHand([card('A', '♠'), card('2', '♥'), card('4', '♦'), card('6', '♣'), card('9', '♠')]);
  assert.strictEqual(res.niu, 0);
  assert.strictEqual(res.label, '无牛');
});

test('纯函数：不修改入参、重复调用结果一致', () => {
  const hand = [card('A', '♠'), card('2', '♥'), card('3', '♦'), card('4', '♣'), card('5', '♠')];
  const snapshot = JSON.stringify(hand);
  const first = E.evaluateHand(hand);
  const second = E.evaluateHand(hand);
  assert.deepStrictEqual(first, second);
  assert.strictEqual(JSON.stringify(hand), snapshot);
});

test('比牌：牛型优先，其次最大单张，最后花色', () => {
  const niu9 = E.evaluateHand([card('A', '♠'), card('9', '♥'), card('10', '♦'), card('2', '♣'), card('7', '♠')]);
  const none = E.evaluateHand([card('K', '♠'), card('9', '♥'), card('7', '♦'), card('5', '♣'), card('2', '♠')]);
  assert.strictEqual(niu9.niu, 9);
  assert.strictEqual(none.niu, 0);
  assert.strictEqual(E.compareHands(niu9, none), 1);

  const niuniuK = E.evaluateHand([card('K', '♠'), card('K', '♥'), card('K', '♦'), card('2', '♣'), card('8', '♠')]);
  const niuniuQ = E.evaluateHand([card('Q', '♠'), card('Q', '♥'), card('Q', '♦'), card('J', '♣'), card('10', '♠')]);
  assert.strictEqual(niuniuK.niu, 10);
  assert.strictEqual(niuniuQ.niu, 10);
  assert.strictEqual(E.compareHands(niuniuK, niuniuQ), 1);

  const spadeMax = E.evaluateHand([card('K', '♠'), card('K', '♥'), card('K', '♦'), card('2', '♣'), card('8', '♠')]);
  const heartMax = E.evaluateHand([card('K', '♥'), card('K', '♦'), card('K', '♣'), card('2', '♠'), card('8', '♥')]);
  assert.strictEqual(E.compareHands(spadeMax, heartMax), 1);
});

test('非法输入直接抛错（不静默返回）', () => {
  assert.throws(() => E.evaluateHand([card('A', '♠')]), /5 张牌/);
  assert.throws(() => E.evaluateHand([card('A', '♠'), card('2', '♥'), card('3', '♦'), card('4', '♣'), card('X', '♠')]), /非法牌面/);
});

test('特殊牌型：五小牛 / 五花牛 / 四炸 的判定与倍数', () => {
  const small = E.evaluateHand([card('A', '♠'), card('A', '♥'), card('2', '♦'), card('3', '♣'), card('3', '♠')]); // 和=10
  assert.strictEqual(small.type, 'small');
  assert.strictEqual(small.label, '五小牛');
  assert.strictEqual(small.mult, 6);

  const flowers = E.evaluateHand([card('J', '♠'), card('Q', '♥'), card('K', '♦'), card('J', '♣'), card('Q', '♠')]);
  assert.strictEqual(flowers.type, 'flowers');
  assert.strictEqual(flowers.mult, 5);

  const bomb = E.evaluateHand([card('7', '♠'), card('7', '♥'), card('7', '♦'), card('7', '♣'), card('3', '♠')]);
  assert.strictEqual(bomb.type, 'bomb');
  assert.strictEqual(bomb.mult, 4);
  assert.strictEqual(bomb.bombValue, 7);

  // A A A A 2 同时满足五小与四炸 → 五小优先
  const both = E.evaluateHand([card('A', '♠'), card('A', '♥'), card('A', '♦'), card('A', '♣'), card('2', '♠')]);
  assert.strictEqual(both.type, 'small');

  // 四张 5 不算五小（点数不小于 5），只算四炸
  const bomb5 = E.evaluateHand([card('5', '♠'), card('5', '♥'), card('5', '♦'), card('5', '♣'), card('A', '♠')]);
  assert.strictEqual(bomb5.type, 'bomb');
});

test('牌型层级：五小牛 > 五花牛 > 四炸 > 牛牛 > 牛九；同级按规则再比', () => {
  const small = E.evaluateHand([card('A', '♠'), card('2', '♥'), card('2', '♦'), card('2', '♣'), card('3', '♠')]);
  const flowers = E.evaluateHand([card('J', '♠'), card('Q', '♥'), card('K', '♦'), card('J', '♣'), card('Q', '♠')]);
  const bomb = E.evaluateHand([card('7', '♠'), card('7', '♥'), card('7', '♦'), card('7', '♣'), card('3', '♠')]);
  const niuniu = E.evaluateHand([card('10', '♠'), card('J', '♥'), card('Q', '♦'), card('K', '♣'), card('10', '♥')]);
  const niu9 = E.evaluateHand([card('A', '♠'), card('9', '♥'), card('10', '♦'), card('2', '♣'), card('7', '♠')]);
  assert.strictEqual(E.compareHands(small, flowers), 1);
  assert.strictEqual(E.compareHands(flowers, bomb), 1);
  assert.strictEqual(E.compareHands(bomb, niuniu), 1);
  assert.strictEqual(E.compareHands(niuniu, niu9), 1);

  // 四炸 vs 四炸：比炸弹点数
  const bomb9 = E.evaluateHand([card('9', '♠'), card('9', '♥'), card('9', '♦'), card('9', '♣'), card('3', '♠')]);
  const bomb7 = E.evaluateHand([card('7', '♠'), card('7', '♥'), card('7', '♦'), card('7', '♣'), card('9', '♠')]);
  assert.strictEqual(E.compareHands(bomb9, bomb7), 1);

  // 五花牛 vs 五花牛：比最大单张再比花色
  const flowersK = E.evaluateHand([card('K', '♠'), card('K', '♥'), card('Q', '♦'), card('Q', '♣'), card('J', '♠')]);
  const flowersQ = E.evaluateHand([card('Q', '♠'), card('Q', '♥'), card('Q', '♦'), card('J', '♣'), card('J', '♠')]);
  assert.strictEqual(E.compareHands(flowersK, flowersQ), 1);

  // 牛八 ×2、牛九 ×2
  assert.strictEqual(niu9.mult, 2);
  assert.strictEqual(niuniu.mult, 3);
});

console.log('\n[host engine]');

test('座位分配：4 人满员后拒绝新人', () => {
  const { engine, players } = setup(4);
  assert.deepStrictEqual(players.map((p) => p.seat), [0, 1, 2, 3]);
  const extra = engine.join('第五人');
  assert.strictEqual(extra.ok, false);
  assert.strictEqual(engine.hostSeat, 0);
});

test('少于 2 人不能开局；非房主不能开局', () => {
  const solo = new HostEngine('200001', { robSeconds: 0, revealSeconds: 0 });
  const host = solo.join('独狼');
  assert.strictEqual(solo.start(host.seat, 'a').ok, false);

  const { engine } = setup(2);
  assert.strictEqual(engine.start(1, 'b').ok, false);
  assert.strictEqual(engine.phase, 'lobby');
});

test('发牌：每人 5 张、20 张牌全不重复，开局即进入抢庄阶段', () => {
  const { engine, players } = setup(4);
  assert.strictEqual(engine.start(0, 'deal-1').ok, true);
  assert.strictEqual(engine.phase, 'robbing');
  const all = players.flatMap((p) => engine.hands[p.seat]);
  assert.strictEqual(all.length, 20);
  assert.strictEqual(new Set(all.map((c) => c.rank + c.suit)).size, 20);
  players.forEach((p) => assert.strictEqual(engine.hands[p.seat].length, 5));
});

test('手牌隐私：玩家 view 只有自己前 4 张明牌，不泄露 token / 他人牌面 / 暗牌', () => {
  const { engine, players } = setup(3);
  engine.start(0, 'privacy-1');
  const view = engine.view(1);
  assert.strictEqual(view.hands, null);
  assert.deepStrictEqual(view.yourHand, engine.hands[1].slice(0, 4));
  assert.strictEqual(view.yourHiddenCount, 1);
  assert.strictEqual(view.seats[0].hand, undefined);
  const raw = JSON.stringify(view);
  assert.ok(!raw.includes(players[1].token), 'view 不应包含 token');
  assert.ok(!raw.includes('"token"'), 'view 不应包含 token 字段');
  // 暗牌（第 5 张）连本人都不下发
  assert.ok(!raw.includes(JSON.stringify(engine.hands[1][4])), 'view 不应包含暗牌');
});

test('暗牌：结算前每人只见 4 张，结算后 5 张全公开', () => {
  const { engine, players } = setup(3);
  engine.start(0, 'hole-1');
  players.forEach((p) => {
    const v = engine.view(p.seat);
    assert.strictEqual(v.yourHand.length, 4);
    assert.strictEqual(v.yourHiddenCount, 1);
  });
  robAll(engine, players);
  const mid = engine.view(0);
  assert.strictEqual(mid.yourHand.length, 4, '亮牌阶段暗牌仍未公开');
  revealAll(engine, players);
  const after = engine.view(0);
  assert.strictEqual(after.yourHand.length, 5);
  assert.strictEqual(after.yourHiddenCount, 0);
  assert.deepStrictEqual(after.yourHand, engine.hands[0]);
});

test('重复 start（同 reqId / 牌局中）不会重复发牌', () => {
  const { engine } = setup(4);
  assert.strictEqual(engine.start(0, 'start-dup').ok, true);
  const dup = engine.start(0, 'start-dup');
  assert.strictEqual(dup.ok, false);
  assert.strictEqual(dup.ignored, true);
  assert.strictEqual(engine.round, 1);

  const again = engine.start(0, 'start-other');
  assert.strictEqual(again.ok, false);
  assert.strictEqual(engine.round, 1);
});

console.log('\n[抢庄]');

test('定庄：庄家从抢庄者中产生，抢庄选择不可改、reqId 幂等', () => {
  const { engine, players } = setup(4);
  engine.start(0, 'rob-1');
  assert.strictEqual(engine.reveal(1, 5, 'too-early').ok, false); // 抢庄阶段不能亮牌

  assert.strictEqual(engine.rob(0, true, 'r0').ok, true);
  assert.strictEqual(engine.rob(0, false, 'r0b').ok, true); // 已选，改不了
  assert.strictEqual(engine.robChoices[0], true);
  assert.strictEqual(engine.rob(1, true, 'r1').ok, true);
  assert.strictEqual(engine.rob(1, true, 'r1').ignored, true); // 同 reqId 重复
  assert.strictEqual(Object.keys(engine.robChoices).length, 2);

  engine.rob(2, false, 'r2');
  engine.rob(3, false, 'r3');
  assert.strictEqual(engine.phase, 'revealing');
  assert.ok(engine.bankerSeat === 0 || engine.bankerSeat === 1, '庄家必须是抢庄的人');
  assert.ok(engine.revealed.has(engine.bankerSeat), '庄家自动亮牌');
  assert.strictEqual(engine.multipliers[engine.bankerSeat], 1);
});

test('无人抢庄：从全员中随机定庄', () => {
  const { engine, players } = setup(3);
  engine.start(0, 'rob-none');
  robAll(engine, players, [false, false, false]);
  assert.strictEqual(engine.phase, 'revealing');
  assert.ok(engine.bankerSeat >= 0 && engine.bankerSeat <= 2);
});

test('抢庄超时：未选的视为不抢，随后进入亮牌阶段', () => {
  const { engine } = setup(3);
  engine.start(0, 'rob-timeout');
  engine.rob(0, true, 't0');
  // 模拟定时器触发（等价于真实 setTimeout 到期）
  engine._finishRobbing();
  assert.strictEqual(engine.robChoices[1], false);
  assert.strictEqual(engine.robChoices[2], false);
  assert.strictEqual(engine.phase, 'revealing');
  assert.strictEqual(engine.bankerSeat, 0, '唯一抢庄者必为庄家');

  // 幂等：阶段已推进，重复触发不再生效
  engine._finishRobbing();
  assert.strictEqual(engine.phase, 'revealing');
});

test('亮牌超时：未亮的闲家按 ×5 自动亮牌并结算', () => {
  const { engine } = setup(3);
  engine.start(0, 'rev-timeout');
  robAll(engine, engine.seats.filter(Boolean));
  engine.reveal(engine.seats.find((p) => p && p.seat !== engine.bankerSeat).seat, 12, 'rv0');
  // 还有一个闲家没亮，模拟超时
  engine._finishRevealing();
  assert.strictEqual(engine.phase, 'settled');
  engine.seats.filter(Boolean).forEach((p) => {
    assert.ok(engine.revealed.has(p.seat));
    assert.ok(engine.multipliers[p.seat] >= 1);
  });
  // 幂等：结算后重复触发无副作用
  engine._finishRevealing();
  assert.strictEqual(engine.phase, 'settled');
});

console.log('\n[结算]');

test('庄闲结算：赌注=闲家倍数×胜方牌型倍数，零和，闲家互不比', () => {
  const { engine, players } = setup(4);
  playRound(engine, players, [true, false, false, false], [5, 8, 12, 8]);

  const banker = engine.bankerSeat;
  assert.strictEqual(banker, 0);

  // 用公开牌面独立重算期望 delta：仅 庄 vs 闲，赌注含胜方牌型倍数
  const deltas = new Map(players.map((p) => [p.seat, 0]));
  const mults = [5, 8, 12, 8];
  const evals = new Map(players.map((p) => [p.seat, E.evaluateHand(engine.hands[p.seat])]));
  players.forEach((p) => {
    if (p.seat === banker) return;
    const cmp = E.compareHands(evals.get(banker), evals.get(p.seat));
    if (cmp === 0) return;
    const winMult = cmp > 0 ? evals.get(banker).mult : evals.get(p.seat).mult;
    const stake = mults[p.seat] * winMult;
    if (cmp > 0) {
      deltas.set(banker, deltas.get(banker) + stake);
      deltas.set(p.seat, deltas.get(p.seat) - stake);
    } else {
      deltas.set(p.seat, deltas.get(p.seat) + stake);
      deltas.set(banker, deltas.get(banker) - stake);
    }
  });

  engine.result.ranking.forEach((row) => {
    assert.strictEqual(row.delta, deltas.get(row.seat));
    assert.strictEqual(row.isBanker, row.seat === banker);
    assert.strictEqual(row.label, E.evaluateHand(engine.hands[row.seat]).label);
    assert.strictEqual(row.handMult, E.evaluateHand(engine.hands[row.seat]).mult);
  });
  const scores = players.map((p) => engine.seats[p.seat].score);
  assert.strictEqual(scores.reduce((a, b) => a + b, 0), 0);
});

test('重复亮牌 / 结算后请求不会重复计分', () => {
  const { engine, players } = setup(3);
  engine.start(0, 'idem-1');
  robAll(engine, players);
  const guest = players.find((p) => p.seat !== engine.bankerSeat);
  assert.strictEqual(engine.reveal(guest.seat, 8, 'i0').ok, true);
  assert.strictEqual(engine.reveal(guest.seat, 8, 'i0').ignored, true);
  assert.strictEqual(engine.multipliers[guest.seat], 8);
  revealAll(engine, players);
  assert.strictEqual(engine.phase, 'settled');

  const scores = players.map((p) => engine.seats[p.seat].score);
  assert.strictEqual(engine.reveal(guest.seat, 5, 'i-late').ok, false);
  assert.strictEqual(engine.rob(guest.seat, true, 'i-late-rob').ok, false);
  assert.deepStrictEqual(players.map((p) => engine.seats[p.seat].score), scores);
});

test('结算后才公开全部牌面；庄家标记在结果与座位中可见', () => {
  const { engine, players } = setup(2);
  engine.start(0, 'open-1');
  robAll(engine, players);
  const before = engine.view(0);
  assert.strictEqual(before.hands, null);
  assert.ok(before.bankerSeat === 0 || before.bankerSeat === 1);
  revealAll(engine, players);
  const after = engine.view(0);
  assert.strictEqual(after.phase, 'settled');
  assert.ok(after.hands);
  players.forEach((p) => assert.strictEqual(after.hands[p.seat].length, 5));
  assert.strictEqual(after.result.bankerSeat, engine.bankerSeat);
});

test('token 重连：恢复原座位和原手牌，掉线时禁止开下一局', () => {
  const { engine, players } = setup(4);
  engine.start(0, 'reconnect-1');
  const hand = engine.hands[2].slice();

  engine.markConnected(2, false);
  assert.strictEqual(engine.seats[2].connected, false);

  const restored = engine.join('玩家3（重连）', players[2].token);
  assert.strictEqual(restored.ok, true);
  assert.strictEqual(restored.restored, true);
  assert.strictEqual(restored.seat, 2);
  assert.strictEqual(engine.seats[2].connected, true);
  assert.deepStrictEqual(engine.hands[2], hand);
  assert.deepStrictEqual(engine.view(2).yourHand, hand.slice(0, 4)); // 重连后暗牌仍盖住

  // 掉线玩家的抢庄/亮牌由超时兜底；这里手动推进
  robAll(engine, players);
  revealAll(engine, players);
  assert.strictEqual(engine.phase, 'settled');

  engine.markConnected(2, false);
  const blocked = engine.start(0, 'reconnect-2');
  assert.strictEqual(blocked.ok, false);

  engine.join('玩家3', players[2].token);
  assert.strictEqual(engine.start(0, 'reconnect-3').ok, true);
  assert.strictEqual(engine.round, 2);
});

test('牌局中（robbing/revealing，无 token）不允许新人加入', () => {
  const { engine, players } = setup(3);
  engine.start(0, 'busy-1');
  assert.strictEqual(engine.join('迟到的人').ok, false);
  robAll(engine, players);
  assert.strictEqual(engine.phase, 'revealing');
  assert.strictEqual(engine.join('又一位').ok, false);
  assert.strictEqual(engine.seats.filter(Boolean).length, 3);
});

test('下一局：轮次递增、分数保留、庄家与抢庄记录清空', () => {
  const { engine, players } = setup(3);
  playRound(engine, players, [true, true, false], [5, 8, 12]);
  const scores = players.map((p) => engine.seats[p.seat].score);
  const prevBanker = engine.bankerSeat;

  assert.strictEqual(engine.start(0, 'next-2').ok, true);
  assert.strictEqual(engine.round, 2);
  assert.strictEqual(engine.phase, 'robbing');
  assert.strictEqual(engine.result, null);
  assert.strictEqual(engine.bankerSeat, null);
  assert.deepStrictEqual(engine.robChoices, {});
  assert.strictEqual(engine.revealed.size, 0);
  assert.notStrictEqual(prevBanker, undefined);
  players.forEach((p, i) => assert.strictEqual(engine.seats[p.seat].score, scores[i]));
});

test('对局数：打满 totalRounds 进入 finished，锁局并产出最终战绩', () => {
  const engine = new HostEngine('400001', { robSeconds: 0, revealSeconds: 0, totalRounds: 2 });
  const players = [engine.join('甲'), engine.join('乙')];

  playRound(engine, players, null, [5, 5]);
  assert.strictEqual(engine.phase, 'settled', '第 1 局后仍可继续');
  assert.strictEqual(engine.view(0).final, null);

  playRound(engine, players, null, [8, 8]);
  assert.strictEqual(engine.phase, 'finished');

  // 锁局：不能再开、新人不能进
  assert.strictEqual(engine.start(0, 'over-1').ok, false);
  assert.strictEqual(engine.join('迟到的人').ok, false);

  // 最终战绩：按总分降序、零和、暗牌全开
  const view = engine.view(0);
  assert.ok(Array.isArray(view.final));
  assert.strictEqual(view.final.reduce((s, r) => s + r.score, 0), 0);
  assert.ok(view.final[0].score >= view.final[1].score);
  assert.strictEqual(view.yourHiddenCount, 0);
  assert.strictEqual(view.yourHand.length, 5);
  assert.strictEqual(view.totalRounds, 2);

  // 重连仍可见最终战绩
  engine.markConnected(1, false);
  const restored = engine.join('乙', players[1].token);
  assert.strictEqual(restored.ok, true);
  assert.strictEqual(engine.view(1).phase, 'finished');
});

test('战绩记录：每局结算写入 history，逐局零和、累计=总分，不含牌面', () => {
  const engine = new HostEngine('500001', { robSeconds: 0, revealSeconds: 0, totalRounds: 3 });
  const players = [engine.join('甲'), engine.join('乙')];
  playRound(engine, players, null, [5, 5]);
  playRound(engine, players, null, [8, 12]);

  const view = engine.view(1);
  assert.strictEqual(view.history.length, 2);
  assert.strictEqual(view.history[0].round, 1);
  assert.strictEqual(view.history[1].round, 2);
  assert.ok(view.history[0].rows.some((r) => r.isBanker));

  const raw = JSON.stringify(view.history);
  assert.ok(!raw.includes('"suit"') && !raw.includes('"hand"'), 'history 不应携带牌面数据');

  view.history.forEach((h) => {
    assert.strictEqual(h.rows.reduce((s, r) => s + r.delta, 0), 0, '第 ' + h.round + ' 局应零和');
  });
  players.forEach((p) => {
    const sum = view.history.reduce((s, h) => s + h.rows.find((r) => r.seat === p.seat).delta, 0);
    assert.strictEqual(engine.seats[p.seat].score, sum, '逐局 delta 累计应等于总分');
  });

  // 重连后仍能看到完整记录
  engine.markConnected(1, false);
  const restored = engine.join('乙', players[1].token);
  assert.strictEqual(restored.ok, true);
  assert.strictEqual(engine.view(1).history.length, 2);
});

test('准备制：大厅全员准备自动开第一局；局间准备自动续局；掉线阻塞、重连补触发；终局拒绝准备', () => {
  const engine = new HostEngine('600001', { robSeconds: 0, revealSeconds: 0, totalRounds: 2 });
  const players = [engine.join('甲'), engine.join('乙')];

  // 大厅阶段：一人准备不开局，全员准备自动开第一局
  assert.strictEqual(engine.phase, 'lobby');
  assert.strictEqual(engine.ready(0, 'lobby-r0').ok, true);
  assert.strictEqual(engine.phase, 'lobby', '只有一人准备不开局');
  assert.strictEqual(engine.ready(1, 'lobby-r1').ok, true);
  assert.strictEqual(engine.phase, 'robbing', '大厅全员准备应自动开第一局');
  assert.strictEqual(engine.round, 1);
  assert.strictEqual(engine.readySet.size, 0, '开局后准备状态清零');

  // 准备阶段被拒绝：抢庄/亮牌期间不能点准备
  assert.strictEqual(engine.ready(0, 'bad-phase').ok, false);

  robAll(engine, players, null);
  revealAll(engine, players, null);
  assert.strictEqual(engine.phase, 'settled');

  // 非结算阶段不能准备 / 重复准备幂等
  const v0 = engine.view(0);
  assert.strictEqual(v0.secondsLeft, null, '结算阶段不再有自动倒计时');
  assert.strictEqual(engine.ready(0, 'rdy-0a').ok, true);
  assert.strictEqual(engine.ready(0, 'rdy-0b').ok, true);
  assert.strictEqual(engine.phase, 'settled', '只有一人准备不开局');
  assert.strictEqual(engine.ready(9, 'rdy-x').ok, false, '无效座位');

  // 全员准备 → 自动开下一局，准备状态清零
  const r1 = engine.round;
  assert.strictEqual(engine.ready(1, 'rdy-1').ok, true);
  assert.strictEqual(engine.phase, 'robbing', '全员准备应自动开局');
  assert.strictEqual(engine.round, r1 + 1);
  assert.strictEqual(engine.readySet.size, 0);

  // 打完最后一局 → finished，准备被拒绝
  robAll(engine, players, null);
  revealAll(engine, players, null);
  assert.strictEqual(engine.phase, 'finished');
  assert.strictEqual(engine.ready(0, 'rdy-end').ok, false);

  // 掉线阻塞：全员准备但有人掉线 → 留在 settled；重连后自动补开
  const engine2 = new HostEngine('600002', { robSeconds: 0, revealSeconds: 0, totalRounds: 5 });
  const p2 = [engine2.join('甲'), engine2.join('乙')];
  playRound(engine2, p2, null, [5, 5]);
  assert.strictEqual(engine2.phase, 'settled');
  engine2.markConnected(1, false);
  engine2.ready(0, 'e2-c0');
  engine2.ready(1, 'e2-c1'); // 掉线前点的准备
  assert.strictEqual(engine2.phase, 'settled', '有人掉线时全员准备也不应开局');
  const restored2 = engine2.join('乙', p2[1].token);
  assert.strictEqual(restored2.restored, true);
  assert.strictEqual(engine2.phase, 'robbing', '掉线者重连后应自动补开');
  engine2.dispose();
  engine.dispose();
});

console.log('\n----------------------------------------');

// dispose 定时器测试是异步的，单独处理后输出总结
(function disposeTest() {
  const engine = new HostEngine('300001', { robSeconds: 0.05, revealSeconds: 0.05 });
  engine.join('甲');
  engine.join('乙');
  engine.start(0, 'timer-1');
  engine.dispose();
  setTimeout(() => {
    try {
      assert.strictEqual(engine.phase, 'robbing', 'dispose 后定时器不应再触发');
      passed += 1;
      console.log('  PASS  dispose：停掉真实定时器，之后超时不再推进');
    } catch (err) {
      failures.push({ name: 'dispose', err });
      console.error('  FAIL  dispose：停掉真实定时器');
    }

    if (failures.length) {
      console.error('失败 ' + failures.length + ' 项，通过 ' + passed + ' 项');
      process.exitCode = 1;
    } else {
      console.log('全部通过：' + passed + ' 项');
    }
  }, 150);
})();
