/*
 * PeerJS 传输层：只负责建立连接与收发 JSON 消息，不掺和游戏规则。
 * 房主 peer id = nnj-<房间号>，玩家通过同一个 id 连到房主。
 */
(function (root) {
  'use strict';

  const ID_PREFIX = 'nnj-';
  const OPEN_TIMEOUT = 15000;

  /*
   * ICE 服务器：仅靠 STUN 时，运营商 CGNAT / 对称 NAT 的手机无法与房主打洞（表现为连接超时）。
   * 带上 TURN 中继后，打洞失败会自动退回中继转发，保证这类网络也能进房。
   */
  const PEER_OPTIONS = {
    config: {
      iceServers: [
        { urls: 'stun:stun.miwifi.com' },
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
        { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
        { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' }
      ],
      iceCandidatePoolSize: 2
    }
  };

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
      const peer = id ? new root.Peer(id, PEER_OPTIONS) : new root.Peer(null, PEER_OPTIONS);
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

  root.Transport = { roomPeerId, createPeer, connectToHost, send };
})(typeof globalThis !== 'undefined' ? globalThis : this);
