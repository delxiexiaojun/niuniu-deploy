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

  function setStatus(text, kind) {
    const el = $('statusLine');
    el.textContent = text;
    el.className = 'status-line ' + (kind || '');
  }

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

  /* ---------------- 房主侧 ---------------- */

  async function createRoom() {
    if (app.busy) return;
    const name = ($('nickname').value || '').trim().slice(0, 12);
    if (!name) { toast('先填个昵称吧', 'warn'); return; }

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

      const engine = new Engine(code, { totalRounds: Number($('selRounds').value) || 12 });
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
      if (previous && previous !== conn && previous.open) {
        try { previous.close(); } catch (e) { /* 忽略 */ }
      }
      app.hostConns.set(result.seat, conn);
      app.connSeat.set(conn, result.seat);
      Transport.send(conn, { t: 'joined', seat: result.seat, token: result.token, roomId: app.roomId });
      Transport.send(conn, { t: 'state', view: app.engine.view(result.seat) });
      broadcast();
      return;
    }

    const seat = app.connSeat.get(conn);
    if (seat === undefined) return;

    if (raw.t === 'start' || raw.t === 'reveal' || raw.t === 'rob' || raw.t === 'ready') {
      const result = raw.t === 'start'
        ? app.engine.start(seat, raw.reqId)
        : raw.t === 'rob'
          ? app.engine.rob(seat, raw.want, raw.reqId)
          : raw.t === 'ready'
            ? app.engine.ready(seat, raw.reqId)
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

    app.busy = true;
    $('lobbyMsg').textContent = '正在连接房主…';
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
      $('lobbyMsg').textContent = '已连接，等待房主确认座位…';

      clearJoinTimer();
      app.joinTimer = setTimeout(() => {
        if (app.mode !== 'guest' || app.view) return;
        toast('房主未响应，连接超时', 'error');
        resetToLobby(false);
      }, 12000);
    } catch (err) {
      console.error(err);
      $('lobbyMsg').textContent = '';
      toast('加入失败：' + (err && err.message ? err.message : err), 'error');
      if (peer) { try { peer.destroy(); } catch (e) { /* 忽略 */ } }
      app.peer = null;
      app.conn = null;
      app.mode = null;
    } finally {
      app.busy = false;
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
      $('lobbyMsg').textContent = '';
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

  function tickCountdown() {
    const el = $('countdown');
    if (!el) return;
    if (app.countdownEnd == null) {
      el.hidden = true;
      el.textContent = '';
      return;
    }
    const left = Math.max(0, Math.ceil((app.countdownEnd - Date.now()) / 1000));
    el.hidden = false;
    el.textContent = '剩余 ' + left + 's';
    el.classList.toggle('urgent', left <= 5);
  }

  setInterval(tickCountdown, 500);

  /* ---------------- 渲染 ---------------- */

  function render(view) {
    if (!view) return;
    app.view = view;

    $('roomId').textContent = view.roomId || app.roomId || '------';
    const phaseText = {
      lobby: '等待玩家',
      robbing: `第 ${view.round}/${view.totalRounds} 局 · 抢庄阶段`,
      revealing: `第 ${view.round}/${view.totalRounds} 局 · 亮牌阶段`,
      settled: `第 ${view.round}/${view.totalRounds} 局 · 已结算`,
      finished: `全部 ${view.totalRounds} 局已完成`
    };
    $('phaseInfo').textContent = phaseText[view.phase] || '';
    app.countdownEnd = view.secondsLeft != null ? Date.now() + view.secondsLeft * 1000 : null;
    tickCountdown();

    renderSeats(view);
    renderHand(view);
    renderResult(view);
    renderHistory(view);
    renderControls(view);
    updateStatus(view);
  }

  function renderSeats(view) {
    const list = $('seatList');
    list.innerHTML = '';
    for (let i = 0; i < 4; i++) {
      const player = view.seats[i];
      const item = document.createElement('li');
      item.className = 'seat' + (player ? '' : ' empty') + (player && player.seat === view.yourSeat ? ' me' : '');

      if (!player) {
        item.innerHTML = '<div class="seat-name">空位</div><div class="seat-sub">等待加入</div>';
      } else {
        const tags = [];
        if (player.seat === view.hostSeat) tags.push('<span class="tag host">房主</span>');
        if (view.bankerSeat === player.seat && view.phase !== 'lobby') {
          tags.push('<span class="tag banker">庄家</span>');
        }
        if (!player.connected) tags.push('<span class="tag bad">掉线</span>');
        if (view.phase === 'robbing') {
          tags.push(player.rob === null
            ? '<span class="tag wait">未选择</span>'
            : player.rob
              ? '<span class="tag ok">抢庄</span>'
              : '<span class="tag wait">不抢</span>');
        } else if (view.phase === 'lobby' && view.seatedCount > 0) {
          tags.push(player.ready
            ? '<span class="tag ok">已准备</span>'
            : '<span class="tag wait">未准备</span>');
        } else if (view.phase === 'revealing' && player.seat !== view.bankerSeat) {
          tags.push(player.revealed
            ? '<span class="tag ok">已亮 ×' + (player.mult || '?') + '</span>'
            : '<span class="tag wait">未亮牌</span>');
        } else if (view.phase === 'settled') {
          tags.push(player.ready
            ? '<span class="tag ok">已准备</span>'
            : '<span class="tag wait">未准备</span>');
        }
        const score = (player.score > 0 ? '+' : '') + player.score;
        item.innerHTML =
          '<div class="seat-name">' + esc(player.name) + tags.join('') + '</div>' +
          '<div class="seat-sub"><span class="dot ' + (player.connected ? 'on' : 'off') + '"></span>' +
          '积分 <strong>' + score + '</strong></div>';
      }
      list.appendChild(item);
    }
  }

  function cardElement(card) {
    const el = document.createElement('div');
    const red = card.suit === '♥' || card.suit === '♦';
    el.className = 'pcard' + (red ? ' red' : '');
    el.innerHTML = '<span class="corner">' + card.rank + '<br>' + card.suit + '</span>' +
      '<span class="big">' + card.suit + '</span>';
    return el;
  }

  function cardsHtml(cards) {
    return (cards || []).map((card) => {
      const red = card.suit === '♥' || card.suit === '♦';
      return '<span class="mcard' + (red ? ' red' : '') + '">' + card.rank + card.suit + '</span>';
    }).join('');
  }

  function renderHand(view) {
    const box = $('myHand');
    box.innerHTML = '';
    const label = $('myLabel');
    const hand = view.yourHand || [];

    if (!hand.length) {
      box.innerHTML = '<span class="muted">' + (view.phase === 'lobby' ? '等待开局' : '本局未发牌') + '</span>';
      label.textContent = '';
      return;
    }

    hand.slice().sort((a, b) => Evaluator.compareCards(b, a)).forEach((card) => {
      box.appendChild(cardElement(card));
    });
    // 暗牌：结算前第 5 张以牌背显示
    if (view.yourHiddenCount > 0) {
      const back = document.createElement('div');
      back.className = 'pcard back';
      back.innerHTML = '<span class="big">?</span>';
      box.appendChild(back);
    }

    if (view.phase === 'settled' && view.result) {
      const mine = view.result.ranking.find((row) => row.seat === view.yourSeat);
      label.textContent = mine
        ? mine.label + '　本轮 ' + (mine.delta > 0 ? '+' : '') + mine.delta + ' 分'
        : '';
    } else if (view.phase === 'robbing') {
      label.textContent = '看牌中 · 选择是否抢庄（暗牌结算时揭晓）';
    } else if (view.phase === 'revealing') {
      const mine = view.seats[view.yourSeat];
      if (view.yourSeat === view.bankerSeat) {
        label.textContent = '你是庄家 · 已自动亮牌，等待闲家（暗牌结算时揭晓）';
      } else {
        label.textContent = mine && mine.revealed
          ? '已亮牌 ×' + (mine.mult || 5) + ' · 等待其他玩家'
          : '暗牌结算时揭晓 · 选个倍数亮牌';
      }
    } else {
      label.textContent = '';
    }
  }

  function renderResult(view) {
    const panel = $('resultPanel');
    const finished = view.phase === 'finished';
    if ((!finished && view.phase !== 'settled') || !view.result) {
      panel.hidden = true;
      return;
    }
    panel.hidden = false;
    $('roundLabel').textContent = finished ? '最终战绩' : '第 ' + view.result.round + ' 局';
    const body = $('resultBody');
    body.innerHTML = '';

    if (finished) {
      // 最终战绩：只展示累计总分排名（牌面/倍数列不适用，合并显示总局数）
      view.final.forEach((row, index) => {
        const tr = document.createElement('tr');
        if (row.seat === view.yourSeat) tr.className = 'me';
        tr.innerHTML = '<td>' + (index + 1) + '</td>' +
          '<td>' + esc(row.name) + (index === 0 ? ' <span class="tag banker">冠军</span>' : '') + '</td>' +
          '<td colspan="3" class="muted">共 ' + view.totalRounds + ' 局</td>' +
          '<td>' + (row.score > 0 ? '+' : '') + row.score + '</td>' +
          '<td>' + row.score + '</td>';
        body.appendChild(tr);
      });
      return;
    }

    view.result.ranking.forEach((row, index) => {
      const tr = document.createElement('tr');
      if (row.seat === view.yourSeat) tr.className = 'me';
      tr.innerHTML = '<td>' + (index + 1) + '</td>' +
        '<td>' + esc(row.name) + (row.isBanker ? ' <span class="tag banker">庄家</span>' : '') + '</td>' +
        '<td>' + (row.isBanker ? '—' : '×' + row.mult) + '</td>' +
        '<td>' + cardsHtml(row.hand) + '</td>' +
        '<td>' + esc(row.label) + (row.handMult > 1 ? ' ×' + row.handMult : '') + '</td>' +
        '<td>' + (row.delta > 0 ? '+' : '') + row.delta + '</td>' +
        '<td>' + row.score + '</td>';
      body.appendChild(tr);
    });
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
    const showRob = view.phase === 'robbing' && me;
    robWrap.hidden = !(showRob && me.rob === null && !busyDead);
    robInfo.hidden = !(showRob && me.rob !== null);
    if (showRob && me.rob !== null) {
      robInfo.textContent = '已选「' + (me.rob ? '抢庄' : '不抢') + '」· 等待其他玩家';
    }

    const revealWrap = $('revealWrap');
    const revealedInfo = $('revealedInfo');
    const showReveal = view.phase === 'revealing' && me;
    revealWrap.hidden = !(showReveal && !isBanker && !me2.revealed && !busyDead);
    revealedInfo.hidden = !(showReveal && (isBanker || me2.revealed));
    if (showReveal && (isBanker || me2.revealed)) {
      revealedInfo.textContent = isBanker
        ? '你是庄家 · 等待闲家亮牌'
        : '已亮牌 ×' + (me2.mult || 5) + ' · 等待其他玩家';
    }

    $('btnReconnect').hidden = !(app.dead && !app.hostLeft && app.mode === 'guest');
  }

  function updateStatus(view) {
    if (app.hostLeft) { setStatus('房主已离开，房间结束', 'bad'); return; }
    if (app.dead) { setStatus('与房主的连接已断开', 'bad'); return; }

    const seated = view.seats.filter(Boolean);
    if (view.phase === 'lobby') {
      const readyCount = seated.filter((p) => p.ready).length;
      setStatus(seated.length + '/4 人已就位 · 全员点「准备」自动开局（' + readyCount + '/' + seated.length +
        ' 已准备，至少 2 人）', '');
    } else if (view.phase === 'robbing') {
      const chosen = seated.filter((player) => player.rob !== null).length;
      setStatus('第 ' + view.round + ' 局 · 抢庄中 ' + chosen + '/' + seated.length + ' 已选择', '');
    } else if (view.phase === 'revealing') {
      const revealed = seated.filter((player) => player.revealed).length;
      const banker = view.bankerSeat !== null && view.seats[view.bankerSeat]
        ? view.seats[view.bankerSeat].name : '?';
      const offline = seated.filter((player) => !player.connected);
      let text = '第 ' + view.round + ' 局 · 庄家：' + banker + ' · 已亮牌 ' + revealed + '/' + seated.length;
      if (offline.length) text += ' · ' + offline.map((player) => player.name).join('、') + ' 掉线中';
      setStatus(text, offline.length ? 'warn' : '');
    } else if (view.phase === 'finished') {
      setStatus('全部 ' + view.totalRounds + ' 局已完成 · 可下载战绩图片', '');
    } else {
      const seatedAll = view.seats.filter(Boolean);
      const readyCount = seatedAll.filter((p) => p.ready).length;
      setStatus('第 ' + view.round + ' 局已结算 · 点「准备」，全员就绪（' + readyCount + '/' + seatedAll.length + '）后自动开始', '');
    }
  }

  /* ---------------- 页面切换 ---------------- */

  function enterRoom() {
    $('lobby').hidden = true;
    $('room').hidden = false;
    $('netBadge').textContent = (app.mode === 'host' ? '房主 · 房间 ' : '玩家 · 房间 ') + app.roomId;
    $('netBadge').className = 'net-badge ' + (app.mode === 'host' ? 'host' : 'guest');
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
    app.hostConns = new Map();
    app.connSeat = new WeakMap();

    if (clearSession) {
      try { localStorage.removeItem(SESSION_KEY); } catch (e) { /* 忽略 */ }
    }

    $('room').hidden = true;
    $('lobby').hidden = false;
    $('netBadge').textContent = '';
    $('lobbyMsg').textContent = '';
    $('btnReconnect').hidden = true;
    $('resultPanel').hidden = true;
    $('historyPanel').hidden = true;
    $('myHand').innerHTML = '';
    updateResumeButton();
  }

  /* ---------------- 操作 ---------------- */

  function actRob(want) {
    if (app.mode === 'host') {
      const result = app.engine.rob(app.seat, want, newReqId());
      if (!result.ok && !result.ignored && result.error) toast(result.error, 'warn');
    } else if (app.conn) {
      Transport.send(app.conn, { t: 'rob', want, reqId: newReqId() });
    }
  }

  function actReveal(mult) {
    if (app.mode === 'host') {
      const result = app.engine.reveal(app.seat, mult, newReqId());
      if (!result.ok && !result.ignored && result.error) toast(result.error, 'warn');
    } else if (app.conn) {
      Transport.send(app.conn, { t: 'reveal', mult, reqId: newReqId() });
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

    $('btnCreate').addEventListener('click', createRoom);
    $('btnJoin').addEventListener('click', () => joinRoom($('roomCode').value, $('nickname').value));
    $('btnResume').addEventListener('click', () => {
      const btn = $('btnResume');
      joinRoom(btn.dataset.room, btn.dataset.name, btn.dataset.token);
    });
    document.querySelectorAll('.rob-btn').forEach((btn) => {
      btn.addEventListener('click', () => actRob(btn.dataset.want === '1'));
    });
    document.querySelectorAll('.mult-btn').forEach((btn) => {
      btn.addEventListener('click', () => actReveal(Number(btn.dataset.mult)));
    });
    $('btnReconnect').addEventListener('click', reconnectGuest);
    $('btnDownload').addEventListener('click', downloadResultImage);
    $('btnHistory').addEventListener('click', toggleHistory);
    $('btnReady').addEventListener('click', actReady);
    $('btnLeave').addEventListener('click', leaveRoom);

    $('roomCode').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') joinRoom($('roomCode').value, $('nickname').value);
    });

    window.addEventListener('beforeunload', () => {
      if (app.mode === 'host') hostBye();
    });
  });
})();
