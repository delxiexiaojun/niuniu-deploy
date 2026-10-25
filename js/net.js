/*
 * 服务器连接层：WebSocket 客户端封装（替代原 PeerJS 传输层）。
 * 只负责建立连接、收发 JSON、心跳与自动重连，不掺和游戏规则。
 *
 * 服务器地址优先级：URL 参数 ?server= > localStorage > 默认常量。
 * 本地开发（localhost / 127.0.0.1）默认连 ws://localhost:8787。
 * Render 免费实例休眠后冷启动要 30-60 秒，所以连接超时放到 60 秒并给出唤醒提示。
 */
(function (root) {
  'use strict';

  const STORAGE_KEY = 'niuniu.server.v1';
  // 部署 Render 后把这里替换成实际分配的 wss 地址（也可用 ?server= 临时指定）
  const DEFAULT_SERVER = 'wss://niuniu-server.onrender.com';
  const CONNECT_TIMEOUT_MS = 60 * 1000;
  const WAKE_HINT_MS = 4000;
  const PING_MS = 25 * 1000;
  const MAX_RETRY_MS = 30 * 1000;

  let ws = null;
  let currentUrl = null;
  let connecting = null;
  let userClosed = false;
  let openedOnce = false;
  let retryTimer = null;
  let retryDelay = 1000;
  let pingTimer = null;
  let statusTimer = null;

  function resolveServerUrl() {
    try {
      const fromQuery = new URLSearchParams(location.search).get('server');
      if (fromQuery) {
        localStorage.setItem(STORAGE_KEY, fromQuery);
        return fromQuery;
      }
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) return saved;
    } catch (e) { /* 无痕模式 / 非浏览器环境 */ }
    const host = (typeof location !== 'undefined' && location.hostname) || '';
    if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0') return 'ws://localhost:8787';
    return DEFAULT_SERVER;
  }

  function notifyStatus(text) {
    try { if (net.onStatus) net.onStatus(text); } catch (e) { /* 忽略 */ }
  }

  function stopPing() {
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
  }

  function startPing() {
    stopPing();
    pingTimer = setInterval(() => {
      if (ws && ws.readyState === 1) {
        try { ws.send(JSON.stringify({ t: 'ping' })); } catch (e) { /* 忽略 */ }
      }
    }, PING_MS);
  }

  function scheduleRetry() {
    if (userClosed || retryTimer) return;
    const delay = Math.min(MAX_RETRY_MS, retryDelay);
    retryDelay = Math.min(MAX_RETRY_MS, retryDelay * 2);
    notifyStatus('与服务器断开，' + Math.round(delay / 1000) + ' 秒后重连…');
    retryTimer = setTimeout(() => {
      retryTimer = null;
      connect(currentUrl).catch(() => { scheduleRetry(); });
    }, delay);
  }

  /** 建立连接；已连上则直接返回。重连成功会触发 onOpen，由上层用 token 回座。 */
  function connect(serverUrl) {
    if (ws && ws.readyState === 1) return Promise.resolve(true);
    if (connecting) return connecting;

    const url = serverUrl || resolveServerUrl();
    currentUrl = url;
    userClosed = false;

    connecting = new Promise((resolve, reject) => {
      let sock = null;
      try {
        sock = new WebSocket(url);
      } catch (e) {
        connecting = null;
        reject(new Error('服务器地址无效：' + url));
        return;
      }
      ws = sock;
      let settled = false;

      const timeout = setTimeout(() => {
        finishErr(new Error('连接服务器超时，请确认服务端已启动'));
      }, CONNECT_TIMEOUT_MS);
      statusTimer = setTimeout(() => {
        if (!settled) notifyStatus('正在唤醒服务器，首次进入约需 30–60 秒…');
      }, WAKE_HINT_MS);

      function clearConnTimers() {
        clearTimeout(timeout);
        clearTimeout(statusTimer);
        statusTimer = null;
      }

      function finishOk() {
        if (settled) return;
        settled = true;
        clearConnTimers();
        connecting = null;
        retryDelay = 1000;
        startPing();
        resolve(true);
      }

      function finishErr(err) {
        if (settled) return;
        settled = true;
        clearConnTimers();
        connecting = null;
        try { sock.close(); } catch (e) { /* 忽略 */ }
        reject(err);
      }

      sock.onopen = () => {
        if (settled) return;
        const reopen = openedOnce;
        finishOk();
        openedOnce = true;
        if (reopen) {
          try { if (net.onOpen) net.onOpen(); } catch (e) { /* 忽略 */ }
        }
      };
      sock.onmessage = (ev) => {
        let msg = null;
        try { msg = JSON.parse(ev.data); } catch (e) { return; }
        if (!msg || typeof msg !== 'object') return;
        if (msg.t === 'pong') return;
        try { if (net.onMessage) net.onMessage(msg); } catch (e) { console.error(e); }
      };
      sock.onerror = () => { /* close 随后触发，统一在那里处理 */ };
      sock.onclose = () => {
        if (ws === sock) ws = null;
        stopPing();
        if (!settled) { finishErr(new Error('连接服务器失败，请稍后重试')); return; }
        try { if (net.onClose) net.onClose(); } catch (e) { /* 忽略 */ }
        if (!userClosed) scheduleRetry();
      };
    });
    return connecting;
  }

  function send(msg) {
    if (!ws || ws.readyState !== 1) return false;
    try {
      ws.send(JSON.stringify(msg));
      return true;
    } catch (e) {
      return false;
    }
  }

  function close() {
    userClosed = true;
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    if (statusTimer) { clearTimeout(statusTimer); statusTimer = null; }
    stopPing();
    if (ws) {
      try { ws.close(); } catch (e) { /* 忽略 */ }
      ws = null;
    }
  }

  const net = {
    onMessage: null,
    onOpen: null,
    onClose: null,
    onStatus: null,
    connect: connect,
    send: send,
    close: close,
    serverUrl: resolveServerUrl,
    get open() { return !!ws && ws.readyState === 1; }
  };

  root.NiuNiuNet = net;
})(typeof globalThis !== 'undefined' ? globalThis : this);
