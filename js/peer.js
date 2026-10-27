/*
 * PeerJS 传输层：只负责建立连接与收发 JSON 消息，不掺和游戏规则。
 * 房主 peer id = nnj-<房间号>，玩家通过同一个 id 连到房主。
 */
(function (root) {
  'use strict';

  const ID_PREFIX = 'nnj-';
  const OPEN_TIMEOUT = 15000;

  /*
   * ICE 服务器：默认只走 STUN（和之前能连通的配置一致）。
   * 免费公网 TURN（openrelay）在国内基本不可达，开着反而拖慢/拖死 ICE 收集，
   * 所以默认关闭，只有链接带 ?turn=1 时才启用中继。
   */
  const STUN_SERVERS = [
    { urls: 'stun:stun.miwifi.com' },
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ];
  const TURN_SERVERS = [
    { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' }
  ];

  function turnEnabled() {
    try {
      if (/[?&]turn=1/.test(root.location.search)) return true;
      return root.localStorage && root.localStorage.getItem('nn_turn') === '1';
    } catch (e) {
      return false;
    }
  }

  function peerOptions() {
    return { config: { iceServers: turnEnabled() ? STUN_SERVERS.concat(TURN_SERVERS) : STUN_SERVERS } };
  }

  /** 网络体检：收集本机 ICE 候选类型，用来判断是 STUN 被拦还是 NAT 打洞失败 */
  function probeIce() {
    return new Promise((resolve) => {
      const out = { host: 0, srflx: 0, relay: 0, err: '' };
      if (typeof root.RTCPeerConnection !== 'function') {
        out.err = '浏览器不支持 WebRTC';
        resolve(out);
        return;
      }
      let pc = null;
      try {
        pc = new root.RTCPeerConnection(peerOptions());
        pc.createDataChannel('probe');
        pc.onicecandidate = (e) => {
          const c = e && e.candidate ? e.candidate.candidate || '' : '';
          if (!c) return;
          if (/typ host/.test(c)) out.host += 1;
          else if (/typ srflx/.test(c)) out.srflx += 1;
          else if (/typ relay/.test(c)) out.relay += 1;
        };
        pc.createOffer().then((offer) => pc.setLocalDescription(offer)).catch((e) => {
          out.err = (e && e.message) || String(e);
        });
      } catch (e) {
        out.err = (e && e.message) || String(e);
      }
      setTimeout(() => {
        try { if (pc) pc.close(); } catch (e) { /* 忽略 */ }
        resolve(out);
      }, 4000);
    });
  }

  function roomPeerId(code) {
    return ID_PREFIX + String(code || '').replace(/\s/g, '');
  }

  /** 创建本地 peer；传入 id 时用于房主占号，不传则随机 id（玩家） */
  function createPeer(id) {
    return new Promise((resolve, reject) => {
      if (typeof root.Peer !== 'function') {
        reject(new Error('PeerJS 未加载，请检查网络后刷新'));
        return;
      }
      const opts = peerOptions();
      const peer = id ? new root.Peer(id, opts) : new root.Peer(undefined, opts);
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error('信令服务器连接超时（PeerJS 云信令可能被网络拦截）'));
      }, OPEN_TIMEOUT);

      peer.on('open', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(peer);
      });
      peer.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { peer.destroy(); } catch (e) { /* 忽略 */ }
        reject(err instanceof Error ? err : new Error('无法连接信令服务器：' + (err && err.type ? err.type : err)));
      });
    });
  }

  /** 玩家连房主，等 DataConnection 打开 */
  function connectToHost(peer, code) {
    return new Promise((resolve, reject) => {
      const conn = peer.connect(roomPeerId(code), { reliable: true });
      let settled = false;
      const finish = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        peer.off('error', onPeerError);
        if (err) {
          try { conn.close(); } catch (e) { /* 忽略 */ }
          reject(err);
        } else {
          resolve(conn);
        }
      };
      const timer = setTimeout(() => {
        const err = new Error('与房主的直连/中继都没打通（运营商网络可能限制了 P2P，请换 Wi-Fi 或用系统浏览器 Safari 打开重试）');
        err.retry = true; // 换一个 peer 重新协商，常常能拿到可用的中继线路
        finish(err);
      }, OPEN_TIMEOUT);
      const onPeerError = (err) => {
        if (err && err.type === 'peer-unavailable') finish(new Error('房间不存在或房主已离线'));
      };
      peer.on('error', onPeerError);
      conn.on('open', () => finish());
      conn.on('error', (err) => finish(new Error('P2P 通道建立失败：' + (err && err.type ? err.type : err))));
    });
  }

  function send(conn, message) {
    if (!conn || !conn.open) return false;
    try {
      conn.send(message);
      return true;
    } catch (e) {
      return false;
    }
  }

  root.Transport = { roomPeerId, createPeer, connectToHost, send, probeIce };
})(typeof globalThis !== 'undefined' ? globalThis : this);
