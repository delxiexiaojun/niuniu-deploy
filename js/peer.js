/*
 * PeerJS 传输层：只负责建立连接与收发 JSON 消息，不掺和游戏规则。
 * 房主 peer id = nnj-<房间号>，玩家通过同一个 id 连到房主。
 */
(function (root) {
  'use strict';

  const ID_PREFIX = 'nnj-';
  const OPEN_TIMEOUT = 15000;

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
      const peer = id ? new root.Peer(id) : new root.Peer();
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
      const timer = setTimeout(() => finish(new Error('与房主的 P2P 连接超时（可能是 NAT / 防火墙限制）')), OPEN_TIMEOUT);
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
