/*
 * UI / 连接控制层。
 * - 房主：本地运行 HostEngine（权威逻辑），把每位玩家各自的 view 通过 PeerJS 发出去。
 * - 玩家：只发送 join / start / reveal，接收权威 state 并渲染，本地不做任何结算。
 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const Transport = window.Transport;
  const Engine = window.NiuNiuGame.HostEngine;
  const Evaluator = window.NiuNiuEvaluator;
  const SESSION_KEY = 'niuniu.session.v1';

  const app = {
    mode: null,        // 'host' | 'guest'
    engine: null,      // 仅房主有
    peer: null,
    conn: null,        // 仅玩家有
    seat: null,
    token: null,
    roomId: null,
    name: '',
    view: null,
    busy: false,
    dead: false,
    hostLeft: false,
    countdownEnd: null,
    autoStartEnd: null,
    phaseLeft: null,
    joinTimer: null,
    hostConns: new Map(),
    connSeat: new WeakMap()
  };

  let toastTimer = null;

  function toast(message, kind) {
    const el = $('toast');
    el.textContent = message;
    el.className = 'toast show ' + (kind || '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.className = 'toast'; }, 3200);
  }

  /** 流程状态打在牌桌中央的小药丸上（阶段+倒计时），不占页面高度 */
  function setStatus(text, kind) {
    const el = $('tableStatus');
    if (!el) return;
    el.hidden = !text;
    el.textContent = text || '';
    el.className = 'table-status' + (kind ? ' ' + kind : '');
  }

  // 全局错误捕获：iOS / 微信内看不到控制台，把异常以 toast 展示出来便于排查
  window.addEventListener('error', (e) => {
    try {
      const msg = e && e.message ? e.message : String(e && e.error ? e.error : e);
      toast('页面异常：' + msg.slice(0, 80), 'error');
    } catch (err) { /* 忽略 */ }
  });
  window.addEventListener('unhandledrejection', (e) => {
    try {
      const reason = e && e.reason;
      const msg = reason && reason.message ? reason.message : String(reason || 'Promise rejected');
      toast('异步异常：' + msg.slice(0, 80), 'error');
    } catch (err) { /* 忽略 */ }
  });

  function esc(value) {
    return String(value).replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
  }

  function newReqId() {
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  function randomCode() {
    return String(Math.floor(100000 + Math.random() * 900000));
  }

  function clearJoinTimer() {
    if (app.joinTimer) {
      clearTimeout(app.joinTimer);
      app.joinTimer = null;
    }
  }

  /** 连接状态同时写大厅与分享入房界面，避免分享入房时用户看不到反馈 */
  function setJoinStatus(text) {
    const lm = $('lobbyMsg');
    if (lm) lm.textContent = text;
    const sm = $('shareMsg');
    if (sm) sm.textContent = text;
  }

  /* ---------------- 房主侧 ---------------- */

  async function createRoom() {
    if (app.busy) return;
    const name = ($('nickname').value || '').trim().slice(0, 12);
    if (!name) { toast('先填个昵称吧', 'warn'); return; }
    try { localStorage.setItem('nn_name', name); } catch (e) { /* ignore */ }

    app.busy = true;
    $('lobbyMsg').textContent = '正在创建房间（连接免费云信令）…';
    try {
      let peer = null;
      let code = '';
      for (let attempt = 0; attempt < 3 && !peer; attempt++) {
        code = randomCode();
        try {
          peer = await Transport.createPeer(Transport.roomPeerId(code));
        } catch (err) {
          if (err && err.type === 'unavailable-id') continue; // 房间号撞车，换一个
          throw err;
        }
      }
      if (!peer) throw new Error('房间号连续冲突，请重试');

      const engine = new Engine(code, {
        totalRounds: Number($('selRounds').value) || 12,
        maxPlayers: Number($('selPlayers').value) || 4
      });
      app.engine = engine;
      engine.onUpdate = broadcast;

      const joined = engine.join(name, null);
      if (!joined.ok) throw new Error(joined.error);

      app.mode = 'host';
      app.peer = peer;
      app.roomId = code;
      app.seat = joined.seat;
      app.token = joined.token;
      app.name = name;
      app.dead = false;
      app.hostLeft = false;
      app.view = null;

      peer.on('connection', onGuestConnection);
      peer.on('disconnected', () => {
        toast('与信令服务器断开，正在重连…', 'warn');
        try { peer.reconnect(); } catch (e) { /* 忽略 */ }
      });
      peer.on('error', (err) => {
        if (err && (err.type === 'network' || err.type === 'server-error')) {
          toast('信令异常：' + err.type, 'warn');
        }
      });

      $('lobbyMsg').textContent = '';
      enterRoom();
      render(engine.view(app.seat));
      toast('房间已创建：' + code + '，把房间号发给朋友', 'ok');
    } catch (err) {
      console.error(err);
      $('lobbyMsg').textContent = '';
      toast('创建失败：' + (err && (err.message || err.type) ? (err.message || err.type) : err), 'error');
    } finally {
      app.busy = false;
    }
  }

  function onGuestConnection(conn) {
    conn.on('data', (raw) => onHostData(conn, raw));
    conn.on('close', () => {
      const seat = app.connSeat.get(conn);
      if (seat === undefined || !app.engine) return;
      if (app.hostConns.get(seat) !== conn) return; // 已被新连接取代
      app.hostConns.delete(seat);
      app.engine.markConnected(seat, false);
      broadcast(); // 立刻通知全桌谁掉线了，不必等下一个动作
    });
    conn.on('error', () => { /* close 会接着触发 */ });
  }

  function onHostData(conn, raw) {
    if (!raw || typeof raw !== 'object' || !app.engine) return;

    if (raw.t === 'join') {
      const result = app.engine.join(raw.name, raw.token);
      if (!result.ok) {
        Transport.send(conn, { t: 'error', message: result.error });
        setTimeout(() => { try { conn.close(); } catch (e) { /* 忽略 */ } }, 200);
        return;
      }
      const previous = app.hostConns.get(result.seat);
      // 先换绑再关旧连接：previous.close() 的 close 事件可能同步触发，
      // 若换绑在后，守卫会误判旧连接仍有效而把座位标成掉线
      app.hostConns.set(result.seat, conn);
      app.connSeat.set(conn, result.seat);
      if (previous && previous !== conn && previous.open) {
        try { previous.close(); } catch (e) { /* 忽略 */ }
      }
      Transport.send(conn, { t: 'joined', seat: result.seat, token: result.token, roomId: app.roomId });
      Transport.send(conn, { t: 'state', view: app.engine.view(result.seat) });
      broadcast();
      return;
    }

    const seat = app.connSeat.get(conn);
    if (seat === undefined) return;

    if (raw.t === 'start' || raw.t === 'reveal' || raw.t === 'rob' || raw.t === 'ready' || raw.t === 'bet' || raw.t === 'restart') {
      const result = raw.t === 'start'
        ? app.engine.start(seat, raw.reqId)
        : raw.t === 'rob'
          ? app.engine.rob(seat, raw.want, raw.reqId)
          : raw.t === 'ready'
            ? app.engine.ready(seat, raw.reqId)
            : raw.t === 'bet'
              ? app.engine.bet(seat, raw.mult, raw.reqId)
              : raw.t === 'restart'
                ? app.engine.restart(seat, raw.reqId)
                : app.engine.reveal(seat, raw.mult, raw.reqId);
      if (!result.ok && !result.ignored && result.error) {
        Transport.send(conn, { t: 'error', message: result.error });
      }
    }
  }

  /** 把每位玩家自己的可见状态推给他；房主自己也重新渲染 */
  function broadcast() {
    if (!app.engine) return;
    app.hostConns.forEach((conn, seat) => {
      Transport.send(conn, { t: 'state', view: app.engine.view(seat) });
    });
    if (app.mode === 'host') render(app.engine.view(app.seat));
  }

  function hostBye() {
    if (!app.engine) return;
    app.hostConns.forEach((conn) => {
      Transport.send(conn, { t: 'host-left' });
    });
  }

  /* ---------------- 玩家侧 ---------------- */

  async function joinRoom(codeInput, nameInput, token) {
    if (app.busy) return;
    const code = String(codeInput || '').replace(/\D/g, '');
    const name = String(nameInput || '').trim().slice(0, 12);
    if (!code) { toast('请输入房间号', 'warn'); return; }
    if (!name) { toast('先填个昵称吧', 'warn'); return; }
    try { localStorage.setItem('nn_name', name); } catch (e) { /* ignore */ }

    app.busy = true;
    setJoinStatus('正在连接房主…');
    let peer = null;
    try {
      peer = await Transport.createPeer();
      const conn = await Transport.connectToHost(peer, code);

      app.mode = 'guest';
      app.peer = peer;
      app.conn = conn;
      app.roomId = code;
      app.name = name;
      app.token = token || null;
      app.dead = false;
      app.hostLeft = false;
      app.view = null;

      conn.on('data', onGuestData);
      conn.on('close', onHostGone);
      conn.on('error', () => { /* close 会接着触发 */ });

      peer.on('error', (err) => {
        if (err && (err.type === 'network' || err.type === 'server-error')) {
          toast('信令异常：' + err.type, 'warn');
        }
      });

      Transport.send(conn, { t: 'join', name, token: token || null });
      setJoinStatus('已连接，等待房主确认座位…');

      clearJoinTimer();
      app.joinTimer = setTimeout(() => {
        if (app.mode !== 'guest' || app.view) return;
        toast('房主未响应，连接超时', 'error');
        resetToLobby(false);
      }, 12000);
    } catch (err) {
      console.error(err);
      setJoinStatus('');
      const detail = err && err.type ? (err.type + (err.message ? '：' + err.message : ''))
        : (err && err.message ? err.message : String(err));
      toast('加入失败：' + detail, 'error');
      if (peer) { try { peer.destroy(); } catch (e) { /* 忽略 */ } }
      app.peer = null;
      app.conn = null;
      app.mode = null;
    } finally {
      app.busy = false;
      const sj = $('btnShareJoin');
      if (sj) { sj.disabled = false; sj.textContent = '进入房间'; }
    }
  }

  function onGuestData(raw) {
    if (!raw || typeof raw !== 'object') return;

    if (raw.t === 'joined') {
      clearJoinTimer();
      app.seat = raw.seat;
      app.token = raw.token;
      if (raw.roomId) app.roomId = raw.roomId;
      saveSession();
      setJoinStatus('');
      enterRoom();
      toast('已加入房间 ' + app.roomId, 'ok');
      return;
    }

    if (raw.t === 'state') {
      if (!app.view) {
        clearJoinTimer();
        enterRoom();
      }
      render(raw.view);
      return;
    }

    if (raw.t === 'host-left') {
      clearJoinTimer();
      app.dead = true;
      app.hostLeft = true;
      app.conn = null;
      $('btnReconnect').hidden = true;
      if (app.view) render(app.view);
      else setStatus('房主已离开，房间结束', 'bad');
      toast('房主已离开，房间结束', 'error');
      return;
    }

    if (raw.t === 'error') {
      toast(raw.message || '房主返回错误', 'error');
      if (!app.view) {
        clearJoinTimer();
        resetToLobby(false);
      }
    }
  }

  function onHostGone() {
    if (app.mode !== 'guest' || app.hostLeft) return;
    app.conn = null;
    app.dead = true;
    if (app.view) render(app.view);
    else setStatus('与房主连接中断', 'bad');
    toast('与房主的连接已断开，可点击「重新连接」用 token 回到原座位', 'warn');
  }

  function reconnectGuest() {
    const roomId = app.roomId;
    const name = app.name;
    const token = app.token;
    if (!roomId || !token) { toast('没有可用的重连凭证，请重新加入房间', 'warn'); return; }
    resetToLobby(false);
    $('roomCode').value = roomId;
    $('nickname').value = name;
    joinRoom(roomId, name, token);
  }

  /* ---------------- 闪烁 / 会话 ---------------- */

  function saveSession() {
    if (app.mode !== 'guest' || !app.token) return;
    try {
      localStorage.setItem(SESSION_KEY, JSON.stringify({ roomId: app.roomId, name: app.name, token: app.token }));
    } catch (e) { /* 忽略无痕模式 */ }
  }

  function updateResumeButton() {
    const btn = $('btnResume');
    let saved = null;
    try {
      saved = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
    } catch (e) {
      localStorage.removeItem(SESSION_KEY);
    }
    if (!saved || !saved.roomId || !saved.token) {
      btn.hidden = true;
      return;
    }
    btn.hidden = false;
    btn.textContent = '重连上次房间 ' + saved.roomId + '（' + saved.name + '）';
    btn.dataset.room = saved.roomId;
    btn.dataset.name = saved.name;
    btn.dataset.token = saved.token;
    if (!$('nickname').value) $('nickname').value = saved.name || '';
  }

  /** 阶段倒计时本地走秒：维护 phaseLeft 并刷新牌桌状态药丸（不再写房间栏倒计时元素） */
  function tickCountdown() {
    app.phaseLeft = app.countdownEnd == null
      ? null
      : Math.max(0, Math.ceil((app.countdownEnd - Date.now()) / 1000));
    if (app.view) updateStatus(app.view);
  }

  /** 开局倒计时本地走秒：状态栏「N 秒后自动开局」每秒动态刷新，不等服务器推送 */
  function tickAutoStart() {
    const view = app.view;
    if (!view || app.autoStartEnd == null) return;
    const left = Math.max(0, Math.ceil((app.autoStartEnd - Date.now()) / 1000));
    if (left === view.startingIn) return;
    view.startingIn = left;
    if (left <= 0) app.autoStartEnd = null; // 归零后等房主推进阶段，服务端状态会覆盖显示
    if (view.phase === 'lobby' || view.phase === 'settled') updateStatus(view);
  }

  setInterval(() => { tickCountdown(); tickAutoStart(); }, 500);

  /* ---------------- 渲染 ---------------- */

  /* 音效安全封装：任何音频异常都不允许阻断游戏动作 */
  function sfxPlay(name) { if (window.Sound) { try { Sound.play(name); } catch (e) { /* 忽略 */ } } }
  function sfxSpeak(text) { if (window.Sound) { try { Sound.speak(text); } catch (e) { /* 忽略 */ } } }
  function sfxVoice(key) { if (window.Sound) { try { Sound.voice(key); } catch (e) { /* 忽略 */ } } }

  /* 牌型文案 -> 真人语音文件 key */
  const LABEL_VOICE = {
    '没牛': 'n0',
    '牛一': 'n1', '牛二': 'n2', '牛三': 'n3', '牛四': 'n4', '牛五': 'n5',
    '牛六': 'n6', '牛七': 'n7', '牛八': 'n8', '牛九': 'n9',
    '牛牛': 'nn', '五花牛': 'whn', '四炸': 'szn', '五小牛': 'wxn'
  };
  function sfxUnlock() { if (window.Sound) { try { Sound.unlock(); } catch (e) { /* 忽略 */ } } }
  // 手机端自动播放策略严格：页面内第一次任意点击/触摸即解锁音频（含真人语音预热）
  document.addEventListener('pointerdown', sfxUnlock, { passive: true });
  document.addEventListener('touchstart', sfxUnlock, { passive: true });

  /** 结算/终局时在每个座位头顶飘出本局得分（正=金色上浮，负=红色），约 2.5s 自动移除。
   *  飘字挂在 .table-wrap（seatList 的父容器）上，renderSeats 只清 seatList 内部，不会误删飘字；
   *  座位 li 的 left/top 百分比与 .table-wrap 同尺寸同原点，直接照搬即可对齐座位 */
  function spawnScoreFloats(view) {
    try {
      const list = $('seatList');
      const wrap = list ? list.parentElement : null;
      if (!wrap || !view.result || !Array.isArray(view.result.ranking)) return;
      view.result.ranking.forEach((row) => {
        if (!row.delta) return;
        const li = list.children[row.seat];
        if (!li) return;
        const el = document.createElement('div');
        el.className = 'score-float ' + (row.delta > 0 ? 'up' : 'down');
        el.textContent = (row.delta > 0 ? '+' : '') + row.delta;
        el.style.left = li.style.left;
        el.style.top = li.style.top;
        wrap.appendChild(el);
        setTimeout(() => { el.remove(); }, 2500);
      });
    } catch (err) { /* 飘字只是点缀，失败不影响游戏 */ }
  }

  /** 根据前后 view 的阶段变化触发音效与语音播报 */
  function playTransitions(prev, view) {
    if (!prev || prev.roomId !== view.roomId) return;
    // 发牌：进入抢庄阶段
    if (view.phase === 'robbing' && prev.phase !== 'robbing') { sfxPlay('deal'); sfxVoice('deal'); }
    // 定庄瞬间（定庄即进入下注阶段）：叮 + 播报庄家
    if (view.phase === 'betting' && prev.phase === 'robbing' && view.bankerSeat !== null) {
      sfxPlay('ding');
      const banker = view.seats[view.bankerSeat];
      if (banker) sfxSpeak(view.bankerSeat === view.yourSeat ? '你是庄家' : '庄家是 ' + banker.name);
    }
    // 我亮牌了
    const meBefore = prev.seats[view.yourSeat];
    const meNow = view.seats[view.yourSeat];
    if (view.yourSeat !== null && meBefore && meNow && !meBefore.revealed && meNow.revealed) {
      sfxPlay('flip');
    }
    // 结算：逐个报牌型（showdown）+ 胜负音 + 自己的得失
    if (view.phase === 'settled' && prev.phase !== 'settled' &&
        view.result && Array.isArray(view.result.ranking)) {
      const mine = view.result.ranking.find((e) => e.seat === view.yourSeat);
      // 牛牛及以上牌型（牛牛/五花牛/四炸/五小牛）先来一段炸裂登场音
      if (mine && mine.handMult >= 3) sfxPlay('boom');
      sfxPlay(mine ? (mine.delta > 0 ? 'win' : mine.delta < 0 ? 'lose' : 'flip') : 'flip');
      // 只报自己的牌型和胜负，不报其他人
      if (mine) {
        const k = LABEL_VOICE[mine.label];
        if (k) sfxVoice(k);
        sfxVoice(mine.delta > 0 ? 'win' : mine.delta < 0 ? 'lose' : 'push');
      }
    }
    // 得分飘字：结算和终局两条路径都要飘（最后一局从亮牌直接进 finished，不经过 settled）
    const resultShown = view.result && Array.isArray(view.result.ranking) &&
      ((view.phase === 'settled' && prev.phase !== 'settled') ||
        (view.phase === 'finished' && prev.phase !== 'finished'));
    if (resultShown) spawnScoreFloats(view);
    // 终局：播报结束语 + 冠军（冠军名是动态的，用 TTS 兜底）
    if (view.phase === 'finished' && prev.phase !== 'finished' && view.final && view.final.length) {
      sfxVoice('over');
      sfxSpeak('冠军是 ' + view.final[0].name);
    }
  }

  function render(view) {
    if (!view) return;
    const prev = app.view;
    app.view = view;
    try {
      playTransitions(prev, view);
    } catch (err) {
      console.error('音效/播报异常（已忽略，不影响游戏）', err);
    }

    $('roomId').textContent = view.roomId || app.roomId || '------';
    const phaseText = {
      lobby: '等待玩家',
      robbing: `第 ${view.round}/${view.totalRounds} 局 · 抢庄阶段`,
      betting: `第 ${view.round}/${view.totalRounds} 局 · 下注阶段`,
      revealing: `第 ${view.round}/${view.totalRounds} 局 · 亮牌阶段`,
      settled: `第 ${view.round}/${view.totalRounds} 局 · 已结算`,
      finished: `全部 ${view.totalRounds} 局已完成`
    };
    $('phaseInfo').textContent = phaseText[view.phase] || '';
    app.countdownEnd = view.secondsLeft != null ? Date.now() + view.secondsLeft * 1000 : null;
    app.autoStartEnd = view.startingIn != null ? Date.now() + view.startingIn * 1000 : null;
    tickCountdown();
    tickAutoStart();

    renderSeats(view);
    renderHistory(view);
    renderControls(view);
    updateStatus(view);
  }

  function renderSeats(view) {
    const list = $('seatList');
    const cardsLayer = $('tableCards');
    list.innerHTML = '';
    cardsLayer.innerHTML = '';
    const n = view.seats.length;
    const me = view.yourSeat !== null && view.yourSeat !== undefined ? view.yourSeat : 0;
    const step = (Math.PI * 2) / n;
    for (let i = 0; i < n; i++) {
      const player = view.seats[i];
      // 环绕牌桌椭圆分布；“我”固定在正下方（角度 90°），其余按座位号顺时针排开
      const angle = Math.PI / 2 + (i - me) * step;
      // 半径收紧：底部座位（正下方）的头像+文字不能溢出桌底把页面撑出滚动条
      const px = 50 + 40 * Math.cos(angle);
      const py = 50 + 34 * Math.sin(angle);

      // 牌直接摆在桌面上：座位内侧（半径 60% 处）的一手牌
      if (player) {
        const hand = document.createElement('div');
        hand.className = 'table-hand' + (player.seat === view.yourSeat ? ' mine' : '');
        hand.style.left = (50 + (px - 50) * 0.6).toFixed(2) + '%';
        hand.style.top = (50 + (py - 50) * 0.6).toFixed(2) + '%';
        hand.innerHTML = tableHandHtml(view, i, player);
        if (hand.innerHTML) cardsLayer.appendChild(hand);
      }

      const item = document.createElement('li');
      item.className = 'seat' + (player ? '' : ' empty') + (player && player.seat === view.yourSeat ? ' me' : '');
      item.style.left = px.toFixed(2) + '%';
      item.style.top = py.toFixed(2) + '%';

      if (!player) {
        item.innerHTML = '<div class="seat-avatar empty-avatar"></div><div class="seat-label">空位</div>';
      } else {
        const badges = [];
        if (player.seat === view.hostSeat) badges.push('<span class="mini-badge host">房</span>');
        if (view.bankerSeat === player.seat && view.phase !== 'lobby') {
          badges.push('<span class="mini-badge banker">庄</span>');
        }
        let status = '';
        let statusCls = 'wait';
        const inRound = view.phase === 'robbing' || view.phase === 'betting' || view.phase === 'revealing'
          ? (view.roundSeats || []).indexOf(player.seat) !== -1
          : true;
        if (!inRound) {
          status = '旁观'; statusCls = 'wait';
        } else if (!player.connected) {
          status = '掉线'; statusCls = 'bad';
        } else if (view.phase === 'robbing') {
          status = player.rob === null ? '未选择' : (player.rob ? '抢庄' : '不抢');
          statusCls = player.rob ? 'ok' : 'wait';
        } else if (view.phase === 'lobby' || view.phase === 'settled') {
          status = player.ready ? '已准备' : '未准备';
          statusCls = player.ready ? 'ok' : 'wait';
        } else if (view.phase === 'betting') {
          if (player.seat === view.bankerSeat) {
            status = '庄家'; statusCls = 'ok';
          } else {
            status = player.bet !== null && player.bet !== undefined ? '已下注×' + player.bet : '未下注';
            statusCls = (player.bet !== null && player.bet !== undefined) ? 'ok' : 'wait';
          }
        } else if (view.phase === 'revealing') {
          if (player.seat === view.bankerSeat) {
            status = '庄家'; statusCls = 'ok';
          } else {
            status = player.revealed ? '已亮×' + (player.mult || '?') : '未亮牌';
            statusCls = player.revealed ? 'ok' : 'wait';
          }
        }
        const score = (player.score > 0 ? '+' : '') + player.score;
        item.innerHTML =
          '<div class="seat-avatar' + (player.connected ? '' : ' off') + '">' +
            esc(player.name.charAt(0) || '?') + badges.join('') + '</div>' +
          '<div class="seat-label">' + esc(player.name) + '</div>' +
          '<div class="seat-score">' + score +
            (status ? ' · <span class="st ' + statusCls + '">' + status + '</span>' : '') + '</div>';
      }
      list.appendChild(item);
    }
  }

  /** 桌面上每个座位的一手牌：结算前别人是 5 张牌背、自己是 4 明 1 暗；结算后全亮 */
  function tableHandHtml(view, i, player) {
    if (!player || view.phase === 'lobby') return '';
    // 本局未参与（开局前未点准备）的旁观者不摆牌
    if (view.phase !== 'settled' && view.phase !== 'finished' &&
        (view.roundSeats || []).indexOf(i) === -1) return '';
    const back = '<span class="mini-card back"></span>';
    const mini = (c) => {
      const red = c.suit === '♥' || c.suit === '♦';
      return '<span class="mini-card' + (red ? ' red' : '') + '">' + c.rank + c.suit + '</span>';
    };
    if (view.phase === 'settled' || view.phase === 'finished') {
      const hand = ((view.hands && view.hands[i]) || []).slice().sort((a, b) => Evaluator.compareCards(b, a));
      return hand.map(mini).join('');
    }
    if (i === view.yourSeat) {
      const mine = (view.yourHand || []).slice().sort((a, b) => Evaluator.compareCards(b, a));
      return mine.map(mini).join('') + back.repeat(Math.max(0, view.yourHiddenCount || 0));
    }
    return back.repeat(5);
  }

  /** 生成最终战绩 PNG 并触发下载（纯 canvas 绘制，无外部依赖） */
  function downloadResultImage() {
    const view = app.view;
    if (!view || !view.final) {
      toast('还没有最终战绩可下载', 'warn');
      return;
    }
    const rows = view.final;
    const W = 920;
    const rowH = 72;
    const H = 300 + rows.length * rowH + 70;
    const scale = 2; // 2 倍清晰度
    const canvas = document.createElement('canvas');
    canvas.width = W * scale;
    canvas.height = H * scale;
    const ctx = canvas.getContext('2d');
    ctx.scale(scale, scale);

    // 背景与边框
    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#0d4034');
    bg.addColorStop(1, '#082a23');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = 'rgba(240, 194, 77, 0.65)';
    ctx.lineWidth = 3;
    ctx.strokeRect(14, 14, W - 28, H - 28);

    // 标题与副信息
    ctx.textAlign = 'center';
    ctx.fillStyle = '#f0c24d';
    ctx.font = '700 52px "Microsoft YaHei", sans-serif';
    ctx.fillText('牛牛 · 最终战绩', W / 2, 96);
    ctx.fillStyle = 'rgba(233, 241, 238, 0.75)';
    ctx.font = '26px "Microsoft YaHei", sans-serif';
    const date = new Date().toLocaleString('zh-CN', { hour12: false });
    ctx.fillText('房间号 ' + view.roomId + ' · 共 ' + view.totalRounds + ' 局 · ' + date, W / 2, 148);

    // 表头
    const top = 200;
    const colX = [90, 330, 700]; // 名次 / 玩家 / 总分
    ctx.fillStyle = 'rgba(240, 194, 77, 0.14)';
    ctx.fillRect(50, top - 44, W - 100, 56);
    ctx.fillStyle = '#f0c24d';
    ctx.font = '700 28px "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('名次', colX[0], top - 6);
    ctx.fillText('玩家', colX[1], top - 6);
    ctx.fillText('总分', colX[2], top - 6);

    // 行
    const medal = ['#f0c24d', '#cfd8dc', '#d29a6b'];
    ctx.font = '30px "Microsoft YaHei", sans-serif';
    rows.forEach((row, i) => {
      const y = top + 44 + i * rowH;
      ctx.fillStyle = i % 2 === 0 ? 'rgba(255, 255, 255, 0.05)' : 'rgba(255, 255, 255, 0.02)';
      ctx.fillRect(50, y - 36, W - 100, rowH - 10);
      ctx.fillStyle = medal[i] || '#e9f1ee';
      ctx.font = '700 30px "Microsoft YaHei", sans-serif';
      ctx.fillText(i === 0 ? '冠军' : String(i + 1), colX[0], y);
      ctx.fillStyle = '#e9f1ee';
      ctx.font = '30px "Microsoft YaHei", sans-serif';
      ctx.fillText(row.name, colX[1], y);
      ctx.fillStyle = row.score > 0 ? '#2fbf8f' : row.score < 0 ? '#e0605c' : '#e9f1ee';
      ctx.font = '700 34px "Consolas, monospace"';
      ctx.fillText((row.score > 0 ? '+' : '') + row.score, colX[2], y);
    });

    // 页脚
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(233, 241, 238, 0.4)';
    ctx.font = '22px "Microsoft YaHei", sans-serif';
    ctx.fillText('P2P 好友局 · 仅供娱乐', W / 2, H - 40);

    canvas.toBlob((blob) => {
      if (!blob) {
        toast('生成图片失败', 'error');
        return;
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = '牛牛战绩-' + view.roomId + '-' + Date.now() + '.png';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    }, 'image/png');
  }

  /** 战绩记录面板：顶部总榜（总分/胜负/单局最高）+ 逐局明细，数据全部来自 view.history 累计 */
  function renderHistory(view) {
    const panel = $('historyPanel');
    if (panel.hidden) return;
    const list = view.history || [];
    $('historyLabel').textContent = list.length ? '已完成 ' + list.length + '/' + view.totalRounds + ' 局' : '';
    const body = $('historyBody');
    if (!list.length) {
      body.innerHTML = '<p class="muted">还没有完成的局，打完一局后这里会有记录。</p>';
      return;
    }

    // 总榜：以座位为底（中途没打过局的玩家也显示 0 分），从逐局记录累计
    const totals = new Map();
    view.seats.filter(Boolean).forEach((p) => {
      totals.set(p.seat, { name: p.name, score: 0, win: 0, lose: 0, draw: 0, best: 0 });
    });
    list.forEach((h) => h.rows.forEach((r) => {
      const t = totals.get(r.seat);
      if (!t) return;
      t.score += r.delta;
      if (r.delta > 0) t.win += 1;
      else if (r.delta < 0) t.lose += 1;
      else t.draw += 1;
      t.best = Math.max(t.best, r.delta);
    }));
    const ranking = Array.from(totals.entries())
      .map(([seat, t]) => ({ seat, name: t.name, score: t.score, win: t.win, lose: t.lose, draw: t.draw, best: t.best }))
      .sort((a, b) => b.score - a.score || b.win - a.win);
    const sumAll = ranking.reduce((s, r) => s + r.score, 0);

    const summaryRows = ranking.map((r, i) =>
      '<tr' + (r.seat === view.yourSeat ? ' class="me"' : '') + '>' +
      '<td>' + (i + 1) + '</td>' +
      '<td>' + esc(r.name) + (i === 0 ? ' <span class="tag banker">冠军</span>' : '') + '</td>' +
      '<td>' + r.win + ' 胜 ' + r.lose + ' 负' + (r.draw ? ' ' + r.draw + ' 平' : '') + '</td>' +
      '<td>+' + r.best + '</td>' +
      '<td class="' + (r.score > 0 ? 'pos' : r.score < 0 ? 'neg' : '') + '">' + (r.score > 0 ? '+' : '') + r.score + '</td>' +
      '</tr>'
    ).join('');
    const summaryHtml =
      '<div class="hist-round summary-round">' +
      '<div class="hist-head">总榜 · 合计 ' + (sumAll > 0 ? '+' : '') + sumAll + '（零和应等于 0）</div>' +
      '<table class="hist-table"><thead><tr><th>名次</th><th>玩家</th><th>战绩</th><th>单局最高</th><th>总分</th></tr></thead>' +
      '<tbody>' + summaryRows + '</tbody></table></div>';

    const roundsHtml = list.map((h) => {
      const bankerRow = h.rows.find((r) => r.isBanker);
      const rows = h.rows.map((r) =>
        '<tr' + (r.seat === view.yourSeat ? ' class="me"' : '') + '>' +
        '<td>' + esc(r.name) + (r.isBanker ? ' <span class="tag banker">庄</span>' : '') + '</td>' +
        '<td>' + esc(r.label) + (r.handMult > 1 ? ' ×' + r.handMult : '') + '</td>' +
        '<td>' + (r.isBanker ? '—' : '×' + r.mult) + '</td>' +
        '<td class="' + (r.delta > 0 ? 'pos' : r.delta < 0 ? 'neg' : '') + '">' +
          (r.delta > 0 ? '+' : '') + r.delta + '</td>' +
        '</tr>'
      ).join('');
      return '<div class="hist-round">' +
        '<div class="hist-head">第 ' + h.round + ' 局 · 庄家：' + esc(bankerRow ? bankerRow.name : '?') + '</div>' +
        '<table class="hist-table"><tbody>' + rows + '</tbody></table></div>';
    }).join('');

    body.innerHTML = summaryHtml + roundsHtml;
  }

  function toggleHistory() {
    const panel = $('historyPanel');
    panel.hidden = !panel.hidden;
    if (!panel.hidden && app.view) {
      renderHistory(app.view);
      panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }

  function renderControls(view) {
    const me = view.yourSeat !== null ? view.seats[view.yourSeat] : null;
    const seated = view.seats.filter(Boolean);

    $('btnDownload').hidden = view.phase !== 'finished';
    // 整场打完后任何人都能点「重新开始」：比分清零回大厅，房间里的人不变，重新准备即可
    $('btnRestart').hidden = !(view.phase === 'finished' && me && !app.dead);

    // 准备制：大厅和结算后都靠「全员准备」自动开局，不再有手动开始/下一局按钮
    const readyBtn = $('btnReady');
    const showReady = (view.phase === 'lobby' || view.phase === 'settled') && me && !app.dead;
    readyBtn.hidden = !showReady;
    if (showReady) {
      const readyCount = seated.filter((p) => p.ready).length;
      readyBtn.disabled = !!me.ready || app.busy;
      readyBtn.textContent = me.ready ? '已准备（' + readyCount + '/' + seated.length + '）' : '准备';
    }

    const me2 = me || {};
    const isBanker = view.yourSeat === view.bankerSeat;
    const busyDead = app.dead || app.busy;

    const robWrap = $('robWrap');
    const robInfo = $('robInfo');
    const inRound = view.inRound !== false; // 未准备的旁观者本局不显示操作按钮
    const spectating = me && !inRound &&
      (view.phase === 'robbing' || view.phase === 'betting' || view.phase === 'revealing');
    const showRob = view.phase === 'robbing' && me && inRound;
    robWrap.hidden = !(showRob && me.rob === null && !busyDead);
    robInfo.hidden = !((showRob && me.rob !== null) || spectating);
    if (spectating) {
      robInfo.textContent = '本局未参与（开局前未点「准备」）· 等待下一局';
    } else if (showRob && me.rob !== null) {
      robInfo.textContent = '已选「' + (me.rob ? '抢庄' : '不抢') + '」· 等待其他玩家';
    }

    // 下注阶段：闲家选倍数（此时只见自己前 4 张）
    const betWrap = $('revealWrap');
    const betInfo = $('betInfo');
    const myBet = me2.bet;
    const hasBet = myBet !== null && myBet !== undefined;
    const showBet = view.phase === 'betting' && me && inRound;
    betWrap.hidden = !(showBet && !isBanker && !hasBet && !busyDead);
    betInfo.hidden = !(showBet && (isBanker || hasBet));
    if (showBet && (isBanker || hasBet)) {
      betInfo.textContent = me2.revealed
        ? '已亮牌 · 等待其他玩家'
        : isBanker
          ? '你是庄家 · 等待闲家下注'
          : '已下注 ×' + myBet + ' · 可点「亮牌」查看牌面';
    }

    // 亮牌：下注后立即可点，不用等其他人；亮牌后本人可见完整 5 张
    const showWrap = $('showWrap');
    const revealedInfo = $('revealedInfo');
    showWrap.hidden = !(me && inRound && !me2.revealed && !busyDead &&
      ((view.phase === 'betting' && hasBet) || (view.phase === 'revealing' && !isBanker)));
    const showReveal = view.phase === 'revealing' && me && inRound;
    revealedInfo.hidden = !(showReveal && (isBanker || me2.revealed));
    if (showReveal && (isBanker || me2.revealed)) {
      revealedInfo.textContent = isBanker
        ? '你是庄家 · 等待闲家亮牌'
        : '已亮牌 · 等待其他玩家';
    }

    $('btnReconnect').hidden = !(app.dead && !app.hostLeft && app.mode === 'guest');
  }

  function updateStatus(view) {
    if (app.hostLeft) { setStatus('房主已离开，房间结束', 'bad'); return; }
    if (app.dead) { setStatus('与房主的连接已断开', 'bad'); return; }

    // 牌桌状态只保留流程关键信息：准备进度 / 倒计时，阶段名已在房间栏 phaseInfo 展示
    const seated = view.seats.filter(Boolean);
    if (view.phase === 'lobby' || view.phase === 'settled') {
      const readyCount = seated.filter((p) => p.ready).length;
      setStatus(view.startingIn
        ? view.startingIn + ' 秒后' + (view.phase === 'lobby' ? '开局' : '开下一局')
        : '准备 ' + readyCount + '/' + seated.length, '');
    } else if (view.phase === 'robbing' || view.phase === 'betting' || view.phase === 'revealing') {
      const label = view.phase === 'robbing' ? '抢庄' : view.phase === 'betting' ? '下注' : '亮牌';
      const players = seated.filter((p) => (view.roundSeats || []).indexOf(p.seat) !== -1);
      const done = view.phase === 'robbing'
        ? players.filter((p) => p.rob !== null).length
        : view.phase === 'betting'
          ? players.filter((p) => p.seat === view.bankerSeat || (p.bet !== null && p.bet !== undefined)).length
          : players.filter((p) => p.revealed).length;
      const left = app.phaseLeft;
      setStatus(label + ' ' + done + '/' + players.length + (left != null ? ' · ' + left + 's' : ''),
        left != null && left <= 5 ? 'urgent' : '');
    } else if (view.phase === 'finished') {
      setStatus('全部 ' + view.totalRounds + ' 局已打完', '');
    }
  }

  /* ---------------- 页面切换 ---------------- */

  function enterRoom() {
    $('lobby').hidden = true;
    $('shareJoin').hidden = true;
    $('room').hidden = false;
    $('netBadge').textContent = (app.mode === 'host' ? '房主 · 房间 ' : '玩家 · 房间 ') + app.roomId;
    $('netBadge').className = 'net-badge ' + (app.mode === 'host' ? 'host' : 'guest');
    // 地址栏带上 ?room=：微信里直接「···→发送给朋友」转发的链接就含房间号
    try { history.replaceState(null, '', location.pathname + '?room=' + app.roomId); } catch (e) { /* ignore */ }
  }

  function resetToLobby(clearSession) {
    clearJoinTimer();
    if (app.mode === 'host') hostBye();
    if (app.engine) app.engine.dispose(); // 停掉阶段定时器
    try { if (app.conn) app.conn.close(); } catch (e) { /* 忽略 */ }
    try { if (app.peer) app.peer.destroy(); } catch (e) { /* 忽略 */ }

    app.mode = null;
    app.engine = null;
    app.peer = null;
    app.conn = null;
    app.seat = null;
    app.token = null;
    app.roomId = null;
    app.view = null;
    app.dead = false;
    app.hostLeft = false;
    app.countdownEnd = null;
    app.autoStartEnd = null;
    app.hostConns = new Map();
    app.connSeat = new WeakMap();

    if (clearSession) {
      try { localStorage.removeItem(SESSION_KEY); } catch (e) { /* 忽略 */ }
    }

    // 从分享链接进来且尚未进房的用户，超时/失败后回到分享入房界面；其余情况回大厅
    const onSharePage = !$('shareJoin').hidden;
    $('room').hidden = true;
    $('lobby').hidden = onSharePage;
    $('shareJoin').hidden = !onSharePage;
    $('netBadge').textContent = '';
    setJoinStatus('');
    $('btnReconnect').hidden = true;
    $('historyPanel').hidden = true;
    updateResumeButton();
  }

  function copyRoomId() {
    const text = $('roomId').textContent.trim();
    if (!/^\d{6}$/.test(text)) return;
    const done = () => toast('房间号 ' + text + ' 已复制，发给朋友即可', 'ok');
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(done, () => legacyCopy(text, done));
    } else {
      legacyCopy(text, done); // 局域网 http 不是安全上下文，clipboard API 不可用
    }
  }

  /** 复制分享链接：带 ?room= 参数，朋友点开输入昵称即可进房 */
  function copyShareLink() {
    if (!app.roomId) return;
    const link = location.origin + location.pathname + '?room=' + app.roomId;
    const done = () => toast('链接已复制，发给朋友点开就能进房', 'ok');
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(link).then(done, () => legacyCopy(link, done));
    } else {
      legacyCopy(link, done); // 局域网 http 不是安全上下文，clipboard API 不可用
    }
  }

  function legacyCopy(text, done) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); done(); }
    catch (e) { toast('复制失败，请手动记录：' + text, 'warn'); }
    document.body.removeChild(ta);
  }

  /* ---------------- 操作 ---------------- */

  function actRob(want) {
    sfxUnlock();
    if (want) { sfxPlay('ding'); sfxVoice('rob'); }
    else { sfxPlay('click'); sfxVoice('norob'); }
    if (app.mode === 'host') {
      const result = app.engine.rob(app.seat, want, newReqId());
      if (!result.ok && !result.ignored && result.error) toast(result.error, 'warn');
    } else if (app.conn) {
      Transport.send(app.conn, { t: 'rob', want, reqId: newReqId() });
    }
  }

  function actBet(mult) {
    sfxUnlock();
    sfxPlay('click');
    sfxVoice('bet' + ([5, 8, 12].includes(mult) ? mult : 5));
    if (app.mode === 'host') {
      const result = app.engine.bet(app.seat, mult, newReqId());
      if (!result.ok && !result.ignored && result.error) toast(result.error, 'warn');
    } else if (app.conn) {
      Transport.send(app.conn, { t: 'bet', mult, reqId: newReqId() });
    }
  }

  function actReveal() {
    sfxUnlock();
    sfxPlay('flip');
    sfxVoice('show');
    if (app.mode === 'host') {
      const result = app.engine.reveal(app.seat, null, newReqId());
      if (!result.ok && !result.ignored && result.error) toast(result.error, 'warn');
    } else if (app.conn) {
      Transport.send(app.conn, { t: 'reveal', reqId: newReqId() });
    }
  }

  function actReady() {
    if (app.mode === 'host') {
      const result = app.engine.ready(app.seat, newReqId());
      if (!result.ok && !result.ignored && result.error) toast(result.error, 'warn');
    } else if (app.conn) {
      Transport.send(app.conn, { t: 'ready', reqId: newReqId() });
    }
  }

  /** 整场打完后一键重开：比分清零回大厅，所有人还在房间里，重新准备即可 */
  function actRestart() {
    if (app.mode === 'host') {
      const result = app.engine.restart(app.seat, newReqId());
      if (!result.ok && !result.ignored && result.error) toast(result.error, 'warn');
    } else if (app.conn) {
      Transport.send(app.conn, { t: 'restart', reqId: newReqId() });
    }
  }

  function leaveRoom() {
    const wasHost = app.mode === 'host';
    if (wasHost && !window.confirm('房主离开会结束整个房间，确定？')) return;
    resetToLobby(true); // resetToLobby 内部会给房主广播 host-left
    toast(wasHost ? '房间已结束' : '已离开房间', 'ok');
  }

  /* ---------------- 启动 ---------------- */

  document.addEventListener('DOMContentLoaded', () => {
    if (typeof window.Peer !== 'function') {
      toast('PeerJS 加载失败：请检查网络，或把 peerjs.min.js 下载到本地引用', 'error');
    }

    updateResumeButton();

    // 记住昵称：创建/加入时存 localStorage，分享链接再来时免输入直接进房
    try {
      const savedName = localStorage.getItem('nn_name');
      if (savedName && !$('nickname').value) $('nickname').value = savedName;
    } catch (e) { /* ignore */ }

    $('btnCreate').addEventListener('click', createRoom);
    $('btnJoin').addEventListener('click', () => joinRoom($('roomCode').value, $('nickname').value));
    $('btnResume').addEventListener('click', () => {
      const btn = $('btnResume');
      joinRoom(btn.dataset.room, btn.dataset.name, btn.dataset.token);
    });
    document.querySelectorAll('.rob-btn').forEach((btn) => {
      btn.addEventListener('click', () => actRob(btn.dataset.want === '1'));
    });
    $('roomId').addEventListener('click', copyRoomId);
    document.querySelectorAll('.mult-btn').forEach((btn) => {
      btn.addEventListener('click', () => actBet(Number(btn.dataset.mult)));
    });
    $('btnShow').addEventListener('click', actReveal);
    $('btnReconnect').addEventListener('click', reconnectGuest);
    $('btnDownload').addEventListener('click', downloadResultImage);
    $('btnHistory').addEventListener('click', toggleHistory);
    $('btnReady').addEventListener('click', actReady);
    $('btnRestart').addEventListener('click', actRestart);
    $('btnLeave').addEventListener('click', leaveRoom);
    $('btnShare').addEventListener('click', copyShareLink);

    // 分享链接进入：?room=XXXXXX 切到独立入房界面（只填昵称，不预填）
    try {
      const shared = new URLSearchParams(location.search).get('room');
      if (shared && /^\d{6}$/.test(shared)) {
        $('lobby').hidden = true;
        $('shareJoin').hidden = false;
        $('shareRoomCode').textContent = shared;
        $('shareNick').focus();
        // 本机存有该房间的重连凭证（异常退出/切出微信后重新点链接）时，自动以原身份回座，绕过昵称占位
        try {
          const saved = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
          if (saved && saved.roomId === shared && saved.token && saved.name) {
            const sj = $('btnShareJoin');
            if (sj) { sj.disabled = true; sj.textContent = '连接中…'; }
            setJoinStatus('检测到「' + saved.name + '」的座位，正在自动回座…');
            joinRoom(shared, saved.name, saved.token);
          }
        } catch (e) { /* ignore */ }
        const doJoin = () => {
          const name = ($('shareNick').value || '').trim().slice(0, 12);
          if (!name) { toast('先填个昵称吧', 'warn'); return; }
          try { localStorage.setItem('nn_name', name); } catch (e) { /* ignore */ }
          const sj = $('btnShareJoin');
          if (sj) { sj.disabled = true; sj.textContent = '连接中…'; }
          joinRoom(shared, name);
        };
        $('btnShareJoin').addEventListener('click', doJoin);
        $('shareNick').addEventListener('keydown', (e) => { if (e.key === 'Enter') doJoin(); });
      }
    } catch (e) { /* ignore */ }
    // 音效：任意按钮点击都先解锁音频（浏览器自动播放策略）并播放点击音
    document.addEventListener('click', (e) => {
      if (e.target.closest('.btn')) {
        sfxUnlock();
        sfxPlay('click');
      }
    });
    // 静音开关（音效模块缺失时隐藏按钮，绝不影响游戏）
    const btnSound = $('btnSound');
    if (!window.Sound) {
      btnSound.hidden = true;
    } else {
      const syncSoundIcon = () => { btnSound.textContent = Sound.isMuted() ? '🔇' : '🔊'; };
      btnSound.addEventListener('click', () => {
        try { Sound.toggle(); } catch (e) { /* 忽略 */ }
        syncSoundIcon();
      });
      syncSoundIcon();
    }

    $('roomCode').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') joinRoom($('roomCode').value, $('nickname').value);
    });

    window.addEventListener('beforeunload', () => {
      if (app.mode === 'host') hostBye();
    });

    // 房主后台自愈：微信切回页面时立即检查过期阶段并推进
    // （微信 WebView 后台会冻结定时器，靠 visibilitychange 回前台时补一次）
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      if (app.mode === 'host' && app.engine) {
        try { app.engine._checkTimeout(); } catch (e) { /* 自愈失败不影响状态 */ }
        broadcast();
      }
      // 玩家切回前台：连接已被后台冻结断开时，用本地 token 自动回原座位
      if (app.mode === 'guest' && !app.hostLeft && !app.busy && app.token && (!app.conn || !app.conn.open)) {
        reconnectGuest();
      }
    });
  });
})();
