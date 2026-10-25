/*
 * 零依赖的最小 WebSocket 服务端（RFC6455 子集）。
 * 只满足本项目需要：文本消息、分片拼接、ping/pong 心跳、正常关闭。
 * 不做压缩与二进制消息，浏览器发来的业务消息都是小 JSON 文本。
 */
'use strict';

const crypto = require('crypto');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_PAYLOAD = 1 << 20; // 单条消息上限 1MB，防御异常客户端

class WSConnection {
  constructor(socket) {
    this.socket = socket;
    this.alive = true;
    this.closed = false;
    this._buffer = Buffer.alloc(0);
    this._fragments = [];
    this.onMessage = function () {};
    this.onClose = function () {};
    this.onPong = function () {};

    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('close', () => this._finish());
    socket.on('error', () => this._finish());
    socket.on('end', () => this._finish());
  }

  send(text) {
    if (this.closed) return false;
    return this._frame(0x1, Buffer.from(String(text), 'utf8'));
  }

  ping() {
    if (this.closed) return;
    this._frame(0x9, Buffer.alloc(0));
  }

  close() {
    if (this.closed) return;
    try { this._frame(0x8, Buffer.from([0x03, 0xe8])); } catch (e) { /* 忽略 */ }
    this._finish();
    try { this.socket.end(); } catch (e) { /* 忽略 */ }
  }

  _finish() {
    if (this.closed) return;
    this.closed = true;
    try { this.onClose(); } catch (e) { /* 忽略 */ }
    try { this.socket.destroy(); } catch (e) { /* 忽略 */ }
  }

  _frame(opcode, payload) {
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.from([0x80 | opcode, len]);
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeUInt32BE(0, 2);
      header.writeUInt32BE(len, 6);
    }
    try {
      this.socket.write(Buffer.concat([header, payload]));
      return true;
    } catch (e) {
      return false;
    }
  }

  _onData(chunk) {
    if (this.closed) return;
    this._buffer = this._buffer.length ? Buffer.concat([this._buffer, chunk]) : chunk;
    while (this._parseFrame()) { /* 继续解析 */ }
  }

  /** 返回 true 表示本次消费了一帧，可以继续解析 */
  _parseFrame() {
    const buf = this._buffer;
    if (buf.length < 2) return false;
    const fin = (buf[0] & 0x80) !== 0;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let len = buf[1] & 0x7f;
    let offset = 2;
    if (len === 126) {
      if (buf.length < 4) return false;
      len = buf.readUInt16BE(2);
      offset = 4;
    } else if (len === 127) {
      if (buf.length < 10) return false;
      len = buf.readUInt32BE(2) * 4294967296 + buf.readUInt32BE(6);
      offset = 10;
    }
    if (len > MAX_PAYLOAD) {
      this.close();
      return false;
    }
    const maskStart = offset;
    if (masked) offset += 4;
    if (buf.length < offset + len) return false;

    let payload = Buffer.from(buf.slice(offset, offset + len));
    if (masked) {
      const mask = buf.slice(maskStart, maskStart + 4);
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
    }
    this._buffer = buf.slice(offset + len);

    if (opcode === 0x8) {           // close
      this.close();
      return false;
    }
    if (opcode === 0x9) {           // ping -> pong
      this._frame(0xA, payload);
      return true;
    }
    if (opcode === 0xA) {           // pong
      this.alive = true;
      try { this.onPong(); } catch (e) { /* 忽略 */ }
      return true;
    }
    if (opcode === 0x1 || opcode === 0x0) {
      this._fragments.push(payload);
      if (fin) {
        const text = Buffer.concat(this._fragments).toString('utf8');
        this._fragments = [];
        try { this.onMessage(text); } catch (e) { /* 业务异常不拖垮连接 */ }
      }
      return true;
    }
    // 其他 opcode（二进制等）直接丢弃
    if (fin) this._fragments = [];
    return true;
  }
}

/** 在 http.Server 上挂 WebSocket 升级处理 */
function attachWebSocket(server, onConnection) {
  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    const upgrade = String(req.headers.upgrade || '').toLowerCase();
    if (upgrade !== 'websocket' || !key) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
    );
    try { socket.setNoDelay(true); } catch (e) { /* 忽略 */ }
    onConnection(new WSConnection(socket));
  });
}

module.exports = { WSConnection, attachWebSocket };
