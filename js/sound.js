/*
 * 音效与语音播报（无任何音频资源文件）：
 * - 音效用 Web Audio 现场合成（发牌噪声、亮牌、定庄叮、胜/负旋律、按钮音）
 * - 报点数用浏览器内置语音合成 speechSynthesis（中文），不支持时静默跳过
 * - 浏览器自动播放策略：首次用户点击时 unlock；静音状态存 localStorage
 */
(function () {
  'use strict';

  let ctx = null;
  let muted = false;
  try { muted = localStorage.getItem('nn_muted') === '1'; } catch (e) { /* ignore */ }

  function ensureCtx() {
    try {
      if (!ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        ctx = new AC();
      }
      if (ctx.state === 'suspended') ctx.resume();
      return ctx;
    } catch (e) {
      return null; // 音频环境异常时静默降级，绝不影响游戏流程
    }
  }

  function tone(freq, delay, dur, type, vol) {
    const c = ensureCtx();
    if (!c || muted) return;
    const t = c.currentTime + (delay || 0);
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type || 'sine';
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol || 0.12, t + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g);
    g.connect(c.destination);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  function noiseBurst(delay, dur, vol, filterFreq) {
    const c = ensureCtx();
    if (!c || muted) return;
    const len = Math.max(1, Math.floor(c.sampleRate * dur));
    const buf = c.createBuffer(1, len, c.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = c.createBufferSource();
    src.buffer = buf;
    const f = c.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = filterFreq || 2400;
    f.Q.value = 0.8;
    const g = c.createGain();
    g.gain.value = vol || 0.18;
    src.connect(f);
    f.connect(g);
    g.connect(c.destination);
    src.start(c.currentTime + (delay || 0));
  }

  /** 滑音：从 f1 扫到 f2，用于低音下坠/上扬的戏剧化效果 */
  function sweep(f1, f2, delay, dur, type, vol) {
    const c = ensureCtx();
    if (!c || muted) return;
    const t = c.currentTime + (delay || 0);
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type || 'sine';
    o.frequency.setValueAtTime(f1, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(1, f2), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol || 0.2, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g);
    g.connect(c.destination);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  // 音色调柔：去掉刺耳高频，音量压低，听感更像赌场背景音
  const effects = {
    click() { tone(620, 0, 0.05, 'triangle', 0.05); },
    deal() { for (let i = 0; i < 5; i++) noiseBurst(i * 0.08, 0.05, 0.1, 1400 + i * 160); },
    flip() { noiseBurst(0, 0.07, 0.12, 1800); tone(520, 0.05, 0.07, 'sine', 0.05); },
    ding() { tone(1046, 0, 0.16, 'sine', 0.08); tone(1568, 0.1, 0.22, 'sine', 0.07); },
    win() { [523, 659, 784, 1046].forEach(function (f, i) { tone(f, i * 0.1, 0.18, 'sine', 0.09); }); },
    // 牛牛及以上的「炸裂」登场音：低音炮下坠 + 镲片噪声 + 铜管上扬齐鸣
    boom() {
      sweep(160, 42, 0, 0.5, 'sine', 0.32);            // 低音炮下坠
      noiseBurst(0, 0.35, 0.22, 5200);                 // 开镲
      noiseBurst(0.02, 0.18, 0.16, 1200);              // 鼓皮冲击
      [261, 329, 392, 523].forEach(function (f) {      // 力量和弦铺底
        tone(f, 0.05, 0.5, 'sawtooth', 0.05);
      });
      [392, 523, 659, 784, 1046].forEach(function (f, i) { // 上扬齐鸣
        tone(f, 0.12 + i * 0.07, 0.22, 'square', 0.06);
      });
      tone(1568, 0.5, 0.35, 'sine', 0.1);              // 收尾亮点
    },
    lose() { tone(330, 0, 0.2, 'triangle', 0.05); tone(262, 0.16, 0.3, 'triangle', 0.05); }
  };

  /* 语音播报：尽量挑「发牌荷官」感的甜美女声。
   * 优先粤语女声（澳门荷官腔），其次中文甜美女声，最后浏览器默认。
   * voices 列表是异步加载的，监听 voiceschanged 后缓存挑选结果。 */
  let pickedVoice = null;
  const VOICE_PREFS = [
    /Tracy/i, /Hilda/i, /Cantonese|粤/i, /zh[-_]HK/i,
    /Xiaoxiao|晓晓/i, /Xiaoyi|晓伊/i, /Yating|雅婷/i, /Tingting|婷婷/i,
    /Huihui|慧慧/i, /Meijia|美佳/i, /Sinji/i, /female|女/i, /Google.*普通话/i
  ];
  function pickVoice() {
    try {
      const voices = window.speechSynthesis.getVoices();
      if (!voices || !voices.length) return null;
      for (let i = 0; i < VOICE_PREFS.length; i++) {
        const hit = voices.find((v) =>
          VOICE_PREFS[i].test(v.name) || VOICE_PREFS[i].test(v.lang || ''));
        if (hit) return hit;
      }
      return voices.find((v) => /zh|中文|Chinese/i.test((v.lang || '') + v.name)) || null;
    } catch (e) {
      return null;
    }
  }
  if ('speechSynthesis' in window) {
    pickedVoice = pickVoice();
    try {
      window.speechSynthesis.onvoiceschanged = function () {
        pickedVoice = pickVoice();
      };
    } catch (e) { /* ignore */ }
  }

  function speak(text) {
    if (muted || !('speechSynthesis' in window)) return;
    try {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      if (!pickedVoice) pickedVoice = pickVoice();
      if (pickedVoice) {
        u.voice = pickedVoice;
        u.lang = pickedVoice.lang || 'zh-CN';
      } else {
        u.lang = 'zh-CN';
      }
      u.pitch = 1.25;  // 音调拉高一点，更像年轻女声
      u.rate = 1.0;    // 语速放缓，荷官报牌腔
      u.volume = 0.9;
      window.speechSynthesis.speak(u);
    } catch (e) { /* 不支持则静默 */ }
  }

  /* 真人语音播报：优先播放 audio/<key>.mp3（Edge-TTS 晓晓女声离线文件），
     文件缺失/播放失败时自动降级为浏览器 TTS。多条播报自动排队不重叠。 */
  const VOICE_CLIPS = {
    deal: '发牌咯', rob: '抢庄', norob: '不抢',
    bet5: '下注，五倍', bet8: '下注，八倍', bet12: '下注，十二倍',
    show: '亮牌', win: '恭喜你赢啦', lose: '这局输了', push: '这局平局',
    over: '对局全部结束，谢谢参与',
    n0: '没牛',
    n1: '牛一', n2: '牛二', n3: '牛三', n4: '牛四', n5: '牛五',
    n6: '牛六', n7: '牛七', n8: '牛八', n9: '牛九',
    nn: '牛牛', whn: '五花牛', szn: '四炸', wxn: '五小牛'
  };
  let voiceQueue = [];
  let voicePlaying = false;
  let voiceBroken = false;

  function pumpVoice() {
    if (voicePlaying || !voiceQueue.length || muted) return;
    const key = voiceQueue.shift();
    let audio;
    try {
      audio = new Audio('audio/' + key + '.mp3');
    } catch (e) {
      voiceBroken = true;
      voiceQueue = [];
      speak(VOICE_CLIPS[key]);
      return;
    }
    audio.volume = 0.95;
    voicePlaying = true;
    const done = function (failed) {
      voicePlaying = false;
      if (failed) {
        voiceBroken = true;
        const rest = voiceQueue.splice(0).map(function (k) { return VOICE_CLIPS[k]; });
        speak([VOICE_CLIPS[key]].concat(rest).join('，'));
        return;
      }
      pumpVoice();
    };
    audio.onended = function () { done(false); };
    audio.onerror = function () { done(true); };
    try {
      const p = audio.play();
      if (p && typeof p.catch === 'function') p.catch(function () { done(true); });
    } catch (e) {
      done(true);
    }
  }

  function voice(key) {
    if (!VOICE_CLIPS[key]) return;
    if (muted) { voiceQueue = []; return; }
    if (voiceBroken) { speak(VOICE_CLIPS[key]); return; }
    voiceQueue.push(key);
    pumpVoice();
  }

  window.Sound = {
    unlock() { ensureCtx(); },
    play(name) {
      if (muted) return;
      const fn = effects[name];
      if (fn) { try { fn(); } catch (e) { /* ignore */ } }
    },
    speak,
    voice,
    toggle() {
      muted = !muted;
      try { localStorage.setItem('nn_muted', muted ? '1' : '0'); } catch (e) { /* ignore */ }
      voiceQueue = [];
      if (muted && 'speechSynthesis' in window) window.speechSynthesis.cancel();
      return muted;
    },
    isMuted() { return muted; }
  };
})();
