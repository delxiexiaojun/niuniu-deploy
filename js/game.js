/*
 * 房主端权威游戏状态机（Host-Authoritative on the host browser）。
 * 不依赖 DOM / 网络：UI 层通过 engine.onUpdate 订阅变化，通过 engine.view(seat) 取该座位的可见状态。
 * 其他玩家的浏览器永远只会收到 view(自己的座位)，别人的手牌不会下发。
 *
 * 每局流程：start() 发牌并进入抢庄（robbing，限时，超时视为不抢）
 *   -> 全员抢完或超时后 _finishRobbing() 从抢庄者中随机定庄（无人抢则全员随机）
 *   -> 亮牌（revealing，限时，超时的闲家按 ×5 自动亮牌；庄家自动亮牌、倍数固定 1）
 *   -> 全员亮完或超时后 _settle()：庄家 vs 每个闲家两两结算，赌注 = 闲家倍数
 */
(function (root) {
  'use strict';
  const Eval = (typeof module === 'object' && module.exports)
    ? require('./evaluator.js')
    : root.NiuNiuEvaluator;

  const SEAT_COUNT = 4;
  const MIN_PLAYERS = 2;
  const MULTIPLIERS = [5, 8, 12];
  const ROB_SECONDS = 10;
  const REVEAL_SECONDS = 20;
  const TOTAL_ROUNDS = 12;
  const SUITS = ['♠', '♥', '♦', '♣'];
  const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

  function newDeck() {
    const deck = [];
    for (const suit of SUITS) {
      for (const rank of RANKS) deck.push({ rank, suit });
    }
    return deck;
  }

  function shuffle(deck) {
    for (let i = deck.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
  }

  function randomToken() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    return 't-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  class HostEngine {
    constructor(roomId, options) {
      const opts = options || {};
      this.roomId = String(roomId);
      this.phase = 'lobby'; // lobby | robbing | revealing | settled
      this.round = 0;
      this.seats = new Array(SEAT_COUNT).fill(null);
      this.hostSeat = null;
      this.bankerSeat = null;
      this.hands = {};            // seat -> 5 张牌（仅房主内存持有）
      this.robChoices = {};       // seat -> true 抢 / false 不抢
      this.revealed = new Set();  // 本局已亮牌的座位
      this.multipliers = {};      // seat -> 闲家亮牌倍数（5/8/12）；庄家固定 1
      this.result = null;         // 结算结果（含公开牌面）
      this.history = [];          // 每局战绩（不含牌面，跨局累积，整场有效）
      this.readySet = new Set();  // 结算后已点「准备」的座位；全员准备自动开下一局
      this.robSeconds = opts.robSeconds !== undefined ? opts.robSeconds : ROB_SECONDS;
      this.revealSeconds = opts.revealSeconds !== undefined ? opts.revealSeconds : REVEAL_SECONDS;
      this.totalRounds = Math.max(1, Number(opts.totalRounds) || TOTAL_ROUNDS);
      this.deadline = null;       // 当前阶段截止时间（房主本机时间，epoch ms）
      this._autoAttempts = 0;     // 自动开局尝试计数（保证 reqId 不被去重）
      this._timers = [];
      this.handledReqIds = new Set();
      this.onUpdate = function () {};
    }

    _touch() {
      this.onUpdate(this);
    }

    /** 请求去重：同一个 reqId 只处理一次，防止重复“开始/抢庄/亮牌”产生副作用 */
    _seen(reqId) {
      if (!reqId) return false;
      if (this.handledReqIds.has(reqId)) return true;
      this.handledReqIds.add(reqId);
      if (this.handledReqIds.size > 200) {
        this.handledReqIds.delete(this.handledReqIds.values().next().value);
      }
      return false;
    }

    _clearTimers() {
      this._timers.forEach(clearTimeout);
      this._timers = [];
    }

    /** 阶段倒计时（仅房主端跑，是权威计时）；seconds <= 0 时完全不启用 */
    _schedule(fn, seconds) {
      if (!seconds || seconds <= 0) return;
      const timer = setTimeout(() => {
        try { fn(); } catch (e) { /* 孤立引擎上的迟发定时器无害 */ }
      }, seconds * 1000);
      if (timer && typeof timer.unref === 'function') timer.unref();
      this._timers.push(timer);
    }

    /** 房主离开 / 房间销毁时调用，停掉所有阶段定时器 */
    dispose() {
      this._clearTimers();
      this.onUpdate = function () {};
    }

    /** 加入或重连。带 token 且命中座位时恢复原座位与手牌。 */
    join(name, token) {
      const safeName = String(name || '').trim().slice(0, 12) || '玩家';

      if (token) {
        const existing = this.seats.find((p) => p && p.token === token);
        if (existing) {
          existing.connected = true;
          this._maybeAutoStart(); // 掉线者重连：若全员早已准备好，这里补触发开局
          this._touch();
          return { ok: true, seat: existing.seat, token: existing.token, restored: true };
        }
      }

      if (this.phase === 'finished') return { ok: false, error: '本场对局已全部结束' };
      if (this.phase === 'robbing' || this.phase === 'revealing') {
        return { ok: false, error: '本局进行中，请等本局结束后再加入' };
      }

      const index = this.seats.findIndex((p) => p === null);
      if (index === -1) return { ok: false, error: '房间已满（4 人）' };

      const newToken = randomToken();
      this.seats[index] = { seat: index, name: safeName, token: newToken, score: 0, connected: true };
      if (this.hostSeat === null) this.hostSeat = index;
      this._touch();
      return { ok: true, seat: index, token: newToken, restored: false };
    }

    /** 大厅/结算后点「准备」：全员准备则自动开局；有人掉线时 start 会拒绝，等其重连后补触发 */
    ready(seat, reqId) {
      if (this._seen(reqId)) return { ok: false, ignored: true };
      if (this.phase !== 'lobby' && this.phase !== 'settled') return { ok: false, error: '当前不在准备阶段' };
      if (!this.seats[seat]) return { ok: false, error: '无效座位' };
      if (this.readySet.has(seat)) return { ok: true }; // 幂等：重复准备无副作用
      this.readySet.add(seat);
      this._maybeAutoStart();
      this._touch();
      return { ok: true };
    }

    /** 全员准备且都在线 → 自动开局（大厅开第一局、结算后开下一局）；条件不满足则继续等待 */
    _maybeAutoStart() {
      if (this.phase !== 'lobby' && this.phase !== 'settled') return;
      const players = this.seats.filter(Boolean);
      if (players.length < MIN_PLAYERS) return;
      if (this.readySet.size < players.length) return;
      this._autoAttempts += 1;
      this.start(this.hostSeat, 'auto-ready-' + this.round + '-' + this._autoAttempts);
    }

    /** 连接断开：保留座位与手牌，等待 token 重连；超时机制会兜底其抢庄/亮牌 */
    markConnected(seat, connected) {
      const player = this.seats[seat];
      if (!player || player.connected === connected) return;
      player.connected = connected;
      this._touch();
    }

    /** 房主开局 / 下一局：发牌并进入抢庄阶段。只有 hostSeat 可调用。 */
    start(seat, reqId) {
      if (this._seen(reqId)) return { ok: false, ignored: true };
      if (seat !== this.hostSeat) return { ok: false, error: '只有房主可以开始 / 下一局' };
      if (this.phase === 'finished') return { ok: false, error: '全部 ' + this.totalRounds + ' 局已完成' };
      if (this.phase === 'robbing' || this.phase === 'revealing') {
        return { ok: false, ignored: true, error: '本局尚未结束' };
      }

      const players = this.seats.filter(Boolean);
      if (players.length < MIN_PLAYERS) return { ok: false, error: '至少需要 2 名玩家（4 人最佳）' };
      const offline = players.find((p) => !p.connected);
      if (offline) return { ok: false, error: offline.name + ' 掉线中，等待重连' };

      const deck = shuffle(newDeck());
      this.hands = {};
      players.forEach((p, i) => {
        this.hands[p.seat] = deck.slice(i * 5, i * 5 + 5);
      });
      this.robChoices = {};
      this.revealed.clear();
      this.multipliers = {};
      this.bankerSeat = null;
      this.result = null;
      this.readySet.clear(); // 新一局开始，准备状态清零
      this.round += 1;
      this.phase = 'robbing';
      this._clearTimers();
      this.deadline = Date.now() + this.robSeconds * 1000;
      this._schedule(() => this._finishRobbing(), this.robSeconds);
      this._touch();
      return { ok: true, round: this.round };
    }

    /** 抢庄：want=true 抢 / false 不抢。选完不可改；全员选完或超时后定庄。 */
    rob(seat, want, reqId) {
      if (this._seen(reqId)) return { ok: false, ignored: true };
      if (this.phase !== 'robbing') return { ok: false, error: '当前不在抢庄阶段' };
      if (!this.seats[seat]) return { ok: false, error: '无效座位' };
      if (Object.prototype.hasOwnProperty.call(this.robChoices, seat)) return { ok: true };

      this.robChoices[seat] = !!want;
      const total = this.seats.filter(Boolean).length;
      if (Object.keys(this.robChoices).length >= total) {
        this._finishRobbing();
      } else {
        this._touch();
      }
      return { ok: true };
    }

    /** 定庄（全员选完或抢庄超时时调用）。幂等：只在 robbing 阶段生效一次。 */
    _finishRobbing() {
      if (this.phase !== 'robbing') return;
      const players = this.seats.filter(Boolean);
      // 超时未选的视为不抢
      players.forEach((p) => {
        if (!Object.prototype.hasOwnProperty.call(this.robChoices, p.seat)) {
          this.robChoices[p.seat] = false;
        }
      });
      const robers = players.filter((p) => this.robChoices[p.seat]);
      const pool = robers.length ? robers : players; // 没人抢则随机一位当庄
      this.bankerSeat = pool[Math.floor(Math.random() * pool.length)].seat;
      // 庄家无需操作：自动亮牌，倍数固定 1
      this.revealed.add(this.bankerSeat);
      this.multipliers[this.bankerSeat] = 1;
      this.phase = 'revealing';
      this._clearTimers();
      this.deadline = Date.now() + this.revealSeconds * 1000;
      this._schedule(() => this._finishRevealing(), this.revealSeconds);
      this._touch();
    }

    /** 闲家亮牌并选定倍数（5/8/12，非法值回退 5）；全员亮完或超时后结算。 */
    reveal(seat, mult, reqId) {
      if (this._seen(reqId)) return { ok: false, ignored: true };
      if (this.phase !== 'revealing') return { ok: false, error: '当前不在亮牌阶段' };
      if (!this.seats[seat]) return { ok: false, error: '无效座位' };
      if (seat === this.bankerSeat) return { ok: true }; // 庄家已自动亮牌
      if (this.revealed.has(seat)) return { ok: true }; // 已亮牌，倍数不可再改

      this.revealed.add(seat);
      this.multipliers[seat] = MULTIPLIERS.includes(mult) ? mult : MULTIPLIERS[0];
      const total = this.seats.filter(Boolean).length;
      if (this.revealed.size >= total) {
        this._settle();
      } else {
        this._touch();
      }
      return { ok: true };
    }

    /** 亮牌超时：未亮的闲家按 ×5 自动亮牌，随后结算。幂等。 */
    _finishRevealing() {
      if (this.phase !== 'revealing') return;
      this.seats.filter(Boolean).forEach((p) => {
        if (!this.revealed.has(p.seat)) {
          this.revealed.add(p.seat);
          this.multipliers[p.seat] = MULTIPLIERS[0];
        }
      });
      this._settle();
    }

    _settle() {
      if (this.phase !== 'revealing') return;
      this._clearTimers();
      this.deadline = null;
      const players = this.seats.filter(Boolean);
      const evals = new Map();
      players.forEach((p) => evals.set(p.seat, Eval.evaluateHand(this.hands[p.seat])));

      // 庄家 vs 每个闲家单独比牌：赌注 = 闲家倍数 × 胜方牌型倍数，平局 0
      const deltas = new Map(players.map((p) => [p.seat, 0]));
      const banker = this.bankerSeat;
      players.forEach((p) => {
        if (p.seat === banker) return;
        const cmp = Eval.compareHands(evals.get(banker), evals.get(p.seat));
        if (cmp === 0) return;
        const winMult = cmp > 0 ? evals.get(banker).mult : evals.get(p.seat).mult;
        const stake = this.multipliers[p.seat] * winMult;
        if (cmp > 0) {
          deltas.set(banker, deltas.get(banker) + stake);
          deltas.set(p.seat, deltas.get(p.seat) - stake);
        } else {
          deltas.set(p.seat, deltas.get(p.seat) + stake);
          deltas.set(banker, deltas.get(banker) - stake);
        }
      });

      players.forEach((p) => { p.score += deltas.get(p.seat); });

      const ranking = players
        .map((p) => {
          const evaluated = evals.get(p.seat);
          return {
            seat: p.seat,
            name: p.name,
            isBanker: p.seat === banker,
            niu: evaluated.niu,
            label: evaluated.label,
            handMult: evaluated.mult,
            mult: this.multipliers[p.seat],
            delta: deltas.get(p.seat),
            score: p.score,
            hand: this.hands[p.seat].slice()
          };
        })
        .sort((x, y) => -Eval.compareHands(evals.get(x.seat), evals.get(y.seat)));

      this.result = { round: this.round, bankerSeat: banker, ranking };
      // 记入战绩历史（不含牌面，刷新/重连后仍可回看）
      this.history.push({
        round: this.round,
        bankerSeat: banker,
        rows: ranking.map((r) => ({
          seat: r.seat, name: r.name, isBanker: r.isBanker,
          label: r.label, handMult: r.handMult, mult: r.mult, delta: r.delta
        }))
      });
      this.phase = this.round >= this.totalRounds ? 'finished' : 'settled';
      this._touch();
    }

    /** 生成某个座位可见的状态：自己的手牌 + 公共信息；别人的手牌只在结算后公开 */
    view(seat) {
      const showdown = this.phase === 'settled' || this.phase === 'finished';
      const publicHands = {};
      if (showdown) {
        Object.keys(this.hands).forEach((key) => {
          publicHands[key] = this.hands[key].slice();
        });
      }
      const ownSeat = Number.isInteger(seat) ? seat : null;
      const timed = this.phase === 'robbing' || this.phase === 'revealing';
      const ownHand = (ownSeat !== null && this.hands[ownSeat]) ? this.hands[ownSeat] : null;
      // 暗牌：结算前第 5 张牌对本人也不下发（不仅是不渲染），结算后才公开
      const hideHole = !!ownHand && !showdown;

      return {
        roomId: this.roomId,
        phase: this.phase,
        round: this.round,
        totalRounds: this.totalRounds,
        hostSeat: this.hostSeat,
        bankerSeat: this.bankerSeat,
        secondsLeft: timed && this.deadline
          ? Math.max(0, Math.ceil((this.deadline - Date.now()) / 1000))
          : null,
        seats: this.seats.map((p) => p ? {
          seat: p.seat,
          name: p.name,
          score: p.score,
          connected: p.connected,
          ready: this.readySet.has(p.seat),
          rob: Object.prototype.hasOwnProperty.call(this.robChoices, p.seat) ? this.robChoices[p.seat] : null,
          revealed: this.revealed.has(p.seat),
          mult: this.revealed.has(p.seat) ? (this.multipliers[p.seat] || null) : null,
          cardCount: this.hands[p.seat] ? this.hands[p.seat].length : 0
        } : null),
        yourSeat: ownSeat,
        yourHand: ownHand ? (hideHole ? ownHand.slice(0, 4) : ownHand.slice()) : null,
        yourHiddenCount: hideHole ? 1 : 0,
        hands: showdown ? publicHands : null,
        result: showdown && this.result ? JSON.parse(JSON.stringify(this.result)) : null,
        history: JSON.parse(JSON.stringify(this.history)),
        final: this.phase === 'finished'
          ? this.seats.filter(Boolean)
              .map((p) => ({ seat: p.seat, name: p.name, score: p.score }))
              .sort((a, b) => b.score - a.score)
          : null
      };
    }
  }

  const api = { HostEngine, SEAT_COUNT, MIN_PLAYERS, MULTIPLIERS, ROB_SECONDS, REVEAL_SECONDS, TOTAL_ROUNDS };
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.NiuNiuGame = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
