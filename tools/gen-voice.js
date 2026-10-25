/*
 * 用微软 Edge-TTS（免费、真人级自然女声）生成游戏播报 mp3。
 * 不依赖第三方包：手写 WebSocket 客户端连 speech.platform.bing.com。
 * 已由用户明确授权本次对外请求（仅发送固定播报短语，无任何隐私数据）。
 * 运行：$env:ELECTRON_RUN_AS_NODE='1'; & 'D:\work\Trae CN\Trae CN.exe' E:\niuniu\tools\gen-voice.js
 * 产物：E:\niuniu\audio\*.mp3
 */
'use strict';
const tls = require('tls');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const HOST = 'speech.platform.bing.com';
const TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const VOICE = process.env.NN_VOICE || 'zh-CN-XiaoxiaoNeural'; // 甜美女声；粤语可用 zh-HK-HiuGaaiNeural
const OUT_DIR = path.join(__dirname, '..', 'audio');

const CLIPS = {
  deal: '发牌咯',
  rob: '抢庄！',
  norob: '不抢',
  bet5: '下注，五倍',
  bet8: '下注，八倍',
  bet12: '下注，十二倍',
  show: '亮牌！',
  win: '恭喜你赢啦',
  lose: '这局输了',
  push: '这局平局',
  over: '对局全部结束，谢谢参与',
  n0: '没牛',
  n1: '牛一', n2: '牛二', n3: '牛三', n4: '牛四', n5: '牛五',
  n6: '牛六', n7: '牛七', n8: '牛八', n9: '牛九',
  nn: '牛牛！',
  whn: '五花牛！',
  szn: '四炸！',
  wxn: '五小牛！'
};

function hex(n) { return crypto.randomBytes(n).toString('hex'); }

function synth(text) {
  return new Promise((resolve, reject) => {
    const connId = hex(16);
    const wsPath = '/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=' +
      TOKEN + '&ConnectionId=' + connId;
    const sock = tls.connect(443, HOST, { servername: HOST });
    const key = crypto.randomBytes(16).toString('base64');
    let handshaken = false;
    let buf = Buffer.alloc(0);
    const audio = [];
    const timer = setTimeout(() => { sock.destroy(); reject(new Error('timeout')); }, 20000);

    function sendText(str) {
      const payload = Buffer.from(str, 'utf8');
      const mask = crypto.randomBytes(4);
      let header;
      if (payload.length < 126) {
        header = Buffer.from([0x81, 0x80 | payload.length]);
      } else {
        header = Buffer.alloc(4);
        header[0] = 0x81;
        header[1] = 0x80 | 126;
        header.writeUInt16BE(payload.length, 2);
      }
      const masked = Buffer.alloc(payload.length);
      for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i % 4];
      sock.write(Buffer.concat([header, mask, masked]));
    }

    function sendMessages() {
      const ts = new Date().toISOString();
      sendText('X-Timestamp:' + ts + '\r\nContent-Type:application/json; charset=utf-8\r\n' +
        'Path:speech.config\r\n\r\n' +
        '{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false",' +
        '"wordBoundaryEnabled":"false"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}');
      const ssml = "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='zh-CN'>" +
        "<voice name='" + VOICE + "'><prosody pitch='+6Hz' rate='-5%' volume='+0%'>" +
        text.replace(/[<>&'"]/g, '') + '</prosody></voice></speak>';
      sendText('X-RequestId:' + hex(16) + '\r\nContent-Type:application/ssml+xml\r\n' +
        'X-Timestamp:' + ts + '\r\nPath:ssml\r\n\r\n' + ssml);
    }

    function onFrames() {
      for (;;) {
        if (buf.length < 2) return;
        const op = buf[0] & 0x0f;
        let len = buf[1] & 0x7f;
        let off = 2;
        if (len === 126) {
          if (buf.length < 4) return;
          len = buf.readUInt16BE(2); off = 4;
        } else if (len === 127) {
          if (buf.length < 10) return;
          len = Number(buf.readBigUInt64BE(2)); off = 10;
        }
        if (buf.length < off + len) return;
        const payload = buf.slice(off, off + len);
        buf = buf.slice(off + len);
        if (op === 2) {
          const hlen = payload.readUInt16BE(0);
          const head = payload.slice(2, 2 + hlen).toString('utf8');
          if (head.includes('Path:audio')) audio.push(payload.slice(2 + hlen));
        } else if (op === 1) {
          if (payload.toString('utf8').includes('Path:turn.end')) {
            clearTimeout(timer);
            sock.destroy();
            resolve(Buffer.concat(audio));
            return;
          }
        }
      }
    }

    sock.on('connect', () => {
      sock.write('GET ' + wsPath + ' HTTP/1.1\r\nHost: ' + HOST + '\r\n' +
        'Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ' + key + '\r\n' +
        'Sec-WebSocket-Version: 13\r\nOrigin: https://www.bing.com\r\n' +
        'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Edge/130.0.0.0\r\n\r\n');
    });
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!handshaken) {
        const idx = buf.indexOf('\r\n\r\n');
        if (idx === -1) return;
        const head = buf.slice(0, idx).toString('utf8');
        if (!head.includes('101')) {
          clearTimeout(timer);
          reject(new Error('handshake failed: ' + head.split('\r\n')[0]));
          return;
        }
        handshaken = true;
        buf = buf.slice(idx + 4);
        sendMessages();
      }
      onFrames();
    });
    sock.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const keys = Object.keys(CLIPS);
  let ok = 0;
  for (const k of keys) {
    try {
      const mp3 = await synth(CLIPS[k]);
      if (!mp3.length) throw new Error('empty audio');
      fs.writeFileSync(path.join(OUT_DIR, k + '.mp3'), mp3);
      ok++;
      console.log('OK  ' + k + '.mp3  ' + CLIPS[k] + '  (' + mp3.length + ' bytes)');
    } catch (err) {
      console.error('ERR ' + k + ': ' + err.message);
    }
  }
  console.log('完成 ' + ok + '/' + keys.length + '，语音：' + VOICE);
  process.exit(ok === keys.length ? 0 : 1);
})();
