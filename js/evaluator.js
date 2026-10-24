/*
 * 牛牛牌型判定 —— 纯函数模块。
 * 只做「牌数组 -> 牛几 / 最大单张」的计算，不碰 DOM、网络、全局状态，可直接在 Node 下单测。
 * 牌模型：{ rank: 'A'|'2'...|'K', suit: '♠'|'♥'|'♦'|'♣' }
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.NiuNiuEvaluator = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const RANK_VALUE = { A: 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '10': 10, J: 11, Q: 12, K: 13 };
  // 牛牛点数：JQK=10，A=1，其余按面值
  const POINT = { A: 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '10': 10, J: 10, Q: 10, K: 10 };
  const SUIT_VALUE = { '♠': 4, '♥': 3, '♣': 2, '♦': 1 }; // 花色大小：黑桃>红桃>梅花>方块
  const CN_NUM = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];

  function isCard(card) {
    return !!card && typeof card === 'object' &&
      Object.prototype.hasOwnProperty.call(POINT, card.rank) &&
      Object.prototype.hasOwnProperty.call(SUIT_VALUE, card.suit);
  }

  /** 单张牌的点数（A=1，JQK=10） */
  function cardPoint(card) {
    if (!isCard(card)) throw new TypeError('非法牌面: ' + JSON.stringify(card));
    return POINT[card.rank];
  }

  /** 比单张：先比点数，再比花色（♠黑桃 > ♥红桃 > ♣梅花 > ♦方块） */
  function compareCards(a, b) {
    if (!isCard(a) || !isCard(b)) throw new TypeError('compareCards 需要两张合法牌');
    const byRank = RANK_VALUE[a.rank] - RANK_VALUE[b.rank];
    return byRank !== 0 ? byRank : SUIT_VALUE[a.suit] - SUIT_VALUE[b.suit];
  }

  /**
   * 判定 5 张牌的牌型。
   * 返回 { niu, type, label, mult, maxCard, bombValue? }：
   *   niu 0=无牛，1~9=牛一~牛九，10=牛牛（特殊牌型 niu 一律记 10）
   *   type: 'none'|'niu'|'bomb'|'flowers'|'small'（五小牛>五花牛>四炸>牛牛>…>无牛）
   *   mult 牌型倍数：无牛~牛七×1，牛八/牛九×2，牛牛×3，四炸×4，五花牛×5，五小牛×6
   * 纯函数：不修改入参，不依赖外部状态。
   */
  function evaluateHand(cards) {
    if (!Array.isArray(cards) || cards.length !== 5) throw new TypeError('evaluateHand 需要恰好 5 张牌');
    const values = cards.map(cardPoint);

    let maxCard = cards[0];
    for (let i = 1; i < 5; i++) {
      if (compareCards(cards[i], maxCard) > 0) maxCard = cards[i];
    }
    const top = { rank: maxCard.rank, suit: maxCard.suit };

    // 特殊牌型（优先级高于普通牛，按 五小牛 > 五花牛 > 四炸 顺序判定）
    const isSmall = values.every((v) => v < 5) && values.reduce((s, v) => s + v, 0) <= 10;
    if (isSmall) return { niu: 10, type: 'small', label: '五小牛', mult: 6, maxCard: top };

    const isFlowers = cards.every((c) => c.rank === 'J' || c.rank === 'Q' || c.rank === 'K');
    if (isFlowers) return { niu: 10, type: 'flowers', label: '五花牛', mult: 5, maxCard: top };

    const counts = {};
    cards.forEach((c) => { counts[c.rank] = (counts[c.rank] || 0) + 1; });
    const bombRank = Object.keys(counts).find((r) => counts[r] === 4);
    if (bombRank) {
      return { niu: 10, type: 'bomb', label: '四炸', mult: 4, maxCard: top, bombValue: POINT[bombRank] };
    }

    let niu = 0;
    // 穷举 C(5,3)=10 种三张组合，找能凑 10 的倍数的组合
    for (let i = 0; i < 3; i++) {
      for (let j = i + 1; j < 4; j++) {
        for (let k = j + 1; k < 5; k++) {
          if ((values[i] + values[j] + values[k]) % 10 !== 0) continue;
          let rest = 0;
          for (let n = 0; n < 5; n++) {
            if (n !== i && n !== j && n !== k) rest += values[n];
          }
          const level = rest % 10 === 0 ? 10 : rest % 10;
          if (level > niu) niu = level;
        }
      }
    }

    return {
      niu,
      type: niu > 0 ? 'niu' : 'none',
      label: niu === 0 ? '无牛' : niu === 10 ? '牛牛' : '牛' + CN_NUM[niu],
      mult: niu === 10 ? 3 : niu === 9 ? 3 : niu >= 7 ? 2 : 1,
      maxCard: top
    };
  }

  /** 比较两个 evaluateHand 结果：先比牌型层级，再比牛数 / 炸弹点数，最后比最大单张与花色 */
  const TYPE_RANK = { none: 0, niu: 1, bomb: 2, flowers: 3, small: 4 };

  function compareHands(a, b) {
    if (!a || !b) throw new TypeError('compareHands 需要两个 evaluateHand 结果');
    const ta = TYPE_RANK[a.type] !== undefined ? TYPE_RANK[a.type] : (a.niu > 0 ? 1 : 0);
    const tb = TYPE_RANK[b.type] !== undefined ? TYPE_RANK[b.type] : (b.niu > 0 ? 1 : 0);
    if (ta !== tb) return ta > tb ? 1 : -1;
    if (a.type === 'bomb' && b.type === 'bomb' && a.bombValue !== b.bombValue) {
      return a.bombValue > b.bombValue ? 1 : -1;
    }
    if (a.niu !== b.niu) return a.niu > b.niu ? 1 : -1;
    return compareCards(a.maxCard, b.maxCard);
  }

  return { RANK_VALUE, SUIT_VALUE, evaluateHand, compareHands, compareCards, cardPoint };
});
