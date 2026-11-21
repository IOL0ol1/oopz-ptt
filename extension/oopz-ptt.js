// Oopz 按键说话 - 页面脚本
// 扩展以 MAIN world 注入，油猴脚本也直接使用这份代码。
(() => {
  'use strict';
  if (window.__oopzPtt) return;

  const VERSION = '0.1.0';
  const HOST_URL = 'ws://127.0.0.1:29271/';
  const HOME_URL = 'https://github.com/IOL0ol1/oopz-ptt';
  const STORE_KEY = 'oopz-ptt';

  const S = {
    cfg: { mode: 'free', binding: null, delay: 200 },
    dirty: false,
    host: false,
    hostVersion: '',
    held: false,
    open: false,
    learning: false,
    level: 0,
  };

  window.__oopzPtt = { version: VERSION, state: S };

  /* ============ 配置 ============ */

  function loadCfg() {
    try {
      const v = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
      if (v && v.cfg) {
        S.cfg = normalizeCfg(v.cfg);
        S.dirty = !!v.dirty;
      }
    } catch (e) { /* 忽略损坏的本地缓存 */ }
  }

  function saveCfg() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify({ cfg: S.cfg, dirty: S.dirty })); } catch (e) { }
  }

  function normalizeCfg(c) {
    const b = c && c.binding;
    const okBinding = b && ((b.dev === 'kb' && b.code > 0 && b.code < 255) || (b.dev === 'mouse' && b.code >= 3 && b.code <= 5));
    return {
      mode: c && c.mode === 'ptt' ? 'ptt' : 'free',
      binding: okBinding ? { dev: b.dev, code: b.code | 0, mods: (b.mods | 0) & 15 } : null,
      delay: Math.max(0, Math.min(2000, (c && c.delay) | 0)),
    };
  }

  function setCfg(patch) {
    const next = normalizeCfg(Object.assign({}, S.cfg, patch));
    const msg = {};
    if (next.mode !== S.cfg.mode) msg.mode = next.mode;
    if (next.delay !== S.cfg.delay) msg.delay = next.delay;
    if ('binding' in patch) {
      if (next.binding) msg.binding = next.binding;
      else msg.clearBinding = true;
    }
    S.cfg = next;
    if (!send({ t: 'set', cfg: msg })) S.dirty = true;
    saveCfg();
    if (!S.host) localReset();
    applyGate();
  }

  loadCfg();

  /* ============ 麦克风闸门 ============ */
  // 只改原始采集轨道的 enabled。对页面暴露的 enabled 仍是页面自己设置的值，
  // 实际值 = 页面的值 && 闸门，这样不会覆盖 Oopz 自己的闭麦。

  const enabledDesc = Object.getOwnPropertyDescriptor(MediaStreamTrack.prototype, 'enabled');
  const tracks = new Set();
  const wants = new WeakMap();

  function gateOpen() {
    return S.cfg.mode !== 'ptt' || S.open;
  }

  function adopt(track, want) {
    if (!track || track.kind !== 'audio' || tracks.has(track)) return;
    wants.set(track, want === undefined ? enabledDesc.get.call(track) : !!want);
    Object.defineProperty(track, 'enabled', {
      configurable: true,
      enumerable: true,
      get() { return wants.get(track); },
      set(v) {
        wants.set(track, !!v);
        enabledDesc.set.call(track, !!v && gateOpen());
        render();
      },
    });
    tracks.add(track);
    enabledDesc.set.call(track, wants.get(track) && gateOpen());
    track.addEventListener('ended', () => { tracks.delete(track); render(); });
    render();
  }

  function liveTracks() {
    const out = [];
    for (const t of tracks) {
      if (t.readyState === 'live') out.push(t);
      else tracks.delete(t);
    }
    return out;
  }

  function applyGate() {
    const g = gateOpen();
    for (const t of liveTracks()) enabledDesc.set.call(t, wants.get(t) && g);
    render();
  }

  function adoptStream(stream) {
    try {
      if (!stream || typeof stream.getAudioTracks !== 'function') return;
      const arr = stream.getAudioTracks();
      for (let i = 0; i < arr.length; i++) adopt(arr[i]);
    } catch (e) { }
  }

  // Oopz 的 trtc.js / iris-web-rtc 会把 getUserMedia 覆盖成 navigator.mediaDevices 的
  // 实例自有属性，直接绕过原型补丁（实测原型被调用 0 次）。因此不在 getUserMedia 函数
  // 本身上做包装（SDK 会读回包装函数再包回去，形成递归），改为在「轨道被真正使用」的
  // 层面拦截：SDK 无论怎么采集，最终一定要取 audio track 并加进 RTC 连接，这里全面覆盖。

  const origGetUserMedia = MediaDevices.prototype.getUserMedia;
  MediaDevices.prototype.getUserMedia = function (constraints) {
    return origGetUserMedia.call(this, constraints).then((stream) => {
      adoptStream(stream);
      return stream;
    });
  };

  // 取轨道时接管：getAudioTracks / getTracks
  (() => {
    const MS = window.MediaStream;
    if (!MS || !MS.prototype) return;
    const gat = MS.prototype.getAudioTracks;
    if (typeof gat === 'function') {
      MS.prototype.getAudioTracks = function () {
        const arr = gat.apply(this, arguments);
        for (let i = 0; i < arr.length; i++) adopt(arr[i]);
        return arr;
      };
    }
    const gt = MS.prototype.getTracks;
    if (typeof gt === 'function') {
      MS.prototype.getTracks = function () {
        const arr = gt.apply(this, arguments);
        for (let i = 0; i < arr.length; i++) adopt(arr[i]);
        return arr;
      };
    }
  })();

  // 轨道进入 RTCPeerConnection 时接管：addTrack / addTransceiver
  // SDK 若绕过 getUserMedia 且直接持有 track，这里仍能拦到最终发送的那一路。
  (() => {
    const RTC = window.RTCPeerConnection;
    if (!RTC || !RTC.prototype) return;
    const addTrack = RTC.prototype.addTrack;
    if (typeof addTrack === 'function') {
      RTC.prototype.addTrack = function (track) {
        try { adopt(track); } catch (e) { }
        return addTrack.apply(this, arguments);
      };
    }
    const addTransceiver = RTC.prototype.addTransceiver;
    if (typeof addTransceiver === 'function') {
      RTC.prototype.addTransceiver = function (trackOrKind) {
        try { if (trackOrKind && trackOrKind.kind === 'audio') adopt(trackOrKind); } catch (e) { }
        return addTransceiver.apply(this, arguments);
      };
    }
  })();

  const origClone = MediaStreamTrack.prototype.clone;
  MediaStreamTrack.prototype.clone = function () {
    const c = origClone.call(this);
    if (tracks.has(this)) adopt(c, wants.get(this));
    return c;
  };

  /* ============ 旁听 RTC 调用，判断 Oopz 自己是否闭麦 ============ */

  const rtcMute = {};

  function rtcMuted() {
    for (const k in rtcMute) if (rtcMute[k]) return true;
    return false;
  }

  function onIris(p) {
    const ev = p && p.event;
    if (typeof ev !== 'string') return;
    let key = null;
    let field = null;
    let invert = false;
    if (ev.includes('muteLocalAudioStream')) { key = 'stream'; field = 'mute'; }
    else if (ev.includes('enableLocalAudio')) { key = 'local'; field = 'enabled'; invert = true; }
    else if (ev.includes('muteRecordingSignal')) { key = 'rec'; field = 'mute'; }
    else if (ev.includes('leaveChannel')) {
      delete rtcMute.stream; delete rtcMute.local; delete rtcMute.rec;
      render();
      return;
    }
    if (!key) return;
    try {
      const d = JSON.parse(p.data);
      if (field in d) {
        rtcMute[key] = invert ? !d[field] : !!d[field];
        render();
      }
    } catch (e) { }
  }

  function hookRtc() {
    const list = window.__AGORA_IRIS_API_ENGINE_LIST__;
    if (list) {
      for (const k of Object.keys(list)) {
        const eng = list[k];
        if (!eng || eng.__oopzPtt || typeof eng.callIrisApi !== 'function') continue;
        const call = eng.callIrisApi;
        eng.callIrisApi = function (p) {
          try { onIris(p); } catch (e) { }
          return call.apply(this, arguments);
        };
        eng.__oopzPtt = true;
      }
    }
    const T = window.TRTC;
    if (T && !T.__oopzPtt && typeof T.create === 'function') {
      try {
        const create = T.create;
        T.create = function () {
          const inst = create.apply(this, arguments);
          try { wrapTrtc(inst); } catch (e) { }
          return inst;
        };
        T.__oopzPtt = true;
      } catch (e) { }
    }
  }

  function wrapTrtc(inst) {
    const upd = inst.updateLocalAudio;
    if (typeof upd === 'function') {
      inst.updateLocalAudio = function (o) {
        if (o && typeof o === 'object' && 'mute' in o) { rtcMute.trtc = !!o.mute; render(); }
        return upd.apply(this, arguments);
      };
    }
    for (const m of ['exitRoom', 'stopLocalAudio']) {
      const f = inst[m];
      if (typeof f === 'function') {
        inst[m] = function () {
          delete rtcMute.trtc;
          render();
          return f.apply(this, arguments);
        };
      }
    }
  }

  setInterval(hookRtc, 1500);

  /* ============ 实际发送的音量 ============ */

  let actx = null;
  let analyser = null;
  let meterTrack = null;
  let meterNode = null;
  let meterBuf = null;

  function meterTick() {
    const live = liveTracks();
    const t = live.length ? live[live.length - 1] : null;
    if (t !== meterTrack) {
      try { if (meterNode) meterNode.disconnect(); } catch (e) { }
      meterNode = null;
      meterTrack = t;
      if (t) {
        try {
          if (!actx) {
            actx = new AudioContext();
            analyser = actx.createAnalyser();
            analyser.fftSize = 512;
            meterBuf = new Float32Array(analyser.fftSize);
          }
          meterNode = actx.createMediaStreamSource(new MediaStream([t]));
          meterNode.connect(analyser);
        } catch (e) { meterNode = null; }
      }
    }
    let level = 0;
    if (meterNode && actx && actx.state === 'running') {
      analyser.getFloatTimeDomainData(meterBuf);
      let sum = 0;
      for (let i = 0; i < meterBuf.length; i++) sum += meterBuf[i] * meterBuf[i];
      level = Math.min(1, Math.sqrt(sum / meterBuf.length) * 6);
    } else if (actx && actx.state === 'suspended' && meterNode) {
      actx.resume().catch(() => { });
    }
    if (Math.abs(level - S.level) > 0.02 || (level === 0 && S.level !== 0)) {
      S.level = level;
      render();
    }
  }

  setInterval(meterTick, 100);

  /* ============ 本地助手 ============ */
  // 扩展：经 bridge.js 和扩展后台转发，不触发浏览器的本地网络权限提示。
  // 油猴脚本：页面直接连 WebSocket，浏览器会询问一次是否允许访问本设备上的应用。

  const TRANSPORT = 'bridge'; // 打包油猴脚本时替换为 'ws'
  const BRIDGE_TAG = '__oopzPtt';

  let ws = null;
  let retry = 0;
  let retryTimer = 0;
  let lna = '';

  function connect() {
    if (TRANSPORT === 'bridge') {
      window.addEventListener('message', (e) => {
        if (e.source !== window || !e.data || e.data[BRIDGE_TAG] !== 'in') return;
        const m = e.data.m;
        if (!m || typeof m.t !== 'string') return;
        if (m.t === '__up') send({ t: 'hello', v: VERSION });
        else if (m.t === '__down') hostDown();
        else onHostMessage(m);
      });
      send({ t: 'hello', v: VERSION });
      return;
    }
    connectWs();
  }

  function connectWs() {
    clearTimeout(retryTimer);
    let sock;
    try { sock = new WebSocket(HOST_URL); } catch (e) { reconnectLater(); return; }
    ws = sock;
    sock.onopen = () => {
      retry = 0;
      sock.send(JSON.stringify({ t: 'hello', v: VERSION }));
    };
    sock.onmessage = (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch (err) { return; }
      onHostMessage(m);
    };
    sock.onclose = () => {
      if (ws !== sock) return;
      ws = null;
      hostDown();
      reconnectLater();
    };
    sock.onerror = () => { };
  }

  function reconnectLater() {
    retry = Math.min(retry + 1, 8);
    retryTimer = setTimeout(connectWs, Math.min(1000 * retry, 8000));
    checkLna();
  }

  // 油猴脚本模式下，查询浏览器是否拦截了对本机的访问，用于界面提示
  async function checkLna() {
    for (const name of ['loopback-network', 'local-network-access']) {
      try {
        const st = (await navigator.permissions.query({ name })).state;
        if (st !== lna) { lna = st; render(); }
        return;
      } catch (e) { }
    }
  }

  function hostDown() {
    const was = S.host;
    S.host = false;
    S.held = false;
    S.open = false;
    S.learning = false;
    applyGate();
    if (was) toast('本地助手已断开');
  }

  function send(o) {
    if (TRANSPORT === 'bridge') {
      window.postMessage({ [BRIDGE_TAG]: 'out', m: o }, location.origin);
      return S.host || o.t === 'hello';
    }
    if (!ws || ws.readyState !== 1) return false;
    ws.send(JSON.stringify(o));
    return true;
  }

  function onHostMessage(m) {
    switch (m.t) {
      case 'state': {
        const first = !S.host;
        S.host = true;
        S.hostVersion = m.v || '';
        localReset();
        if (first && S.dirty) {
          S.dirty = false;
          const c = S.cfg;
          send({ t: 'set', cfg: c.binding ? { mode: c.mode, delay: c.delay, binding: c.binding } : { mode: c.mode, delay: c.delay, clearBinding: true } });
        } else if (m.cfg) {
          S.cfg = normalizeCfg(m.cfg);
        }
        S.held = !!m.held;
        S.open = !!m.open;
        saveCfg();
        applyGate();
        break;
      }
      case 'ptt':
        S.held = !!m.held;
        S.open = !!m.open;
        applyGate();
        break;
      case 'learned':
        S.learning = false;
        if (m.binding) toast('快捷键已设为 ' + bindingName(m.binding));
        render();
        break;
      case 'learnEnd':
        S.learning = false;
        render();
        break;
      case 'openPanel':
        if (ui) ui.openModal();
        break;
    }
  }

  /* ============ 页面内按键（助手未连接时的退路） ============ */

  const local = { held: false, timer: 0, learnMod: 0 };

  function localReset() {
    clearTimeout(local.timer);
    if (local.held || (!S.host && S.open)) {
      local.held = false;
      S.held = false;
      S.open = false;
    }
  }

  function vkFromEvent(e) {
    switch (e.keyCode) {
      case 16: return e.location === 2 ? 0xA1 : 0xA0;
      case 17: return e.location === 2 ? 0xA3 : 0xA2;
      case 18: return e.location === 2 ? 0xA5 : 0xA4;
      default: return e.keyCode;
    }
  }

  const MOUSE_CODE = { 1: 3, 3: 4, 4: 5 };

  function modsFromEvent(e) {
    return (e.ctrlKey ? 1 : 0) | (e.shiftKey ? 2 : 0) | (e.altKey ? 4 : 0) | (e.metaKey ? 8 : 0);
  }

  const isModifierVk = (vk) => (vk >= 0xA0 && vk <= 0xA5) || vk === 0x5B || vk === 0x5C;

  function localActive() {
    return !S.host && S.cfg.mode === 'ptt' && !!S.cfg.binding;
  }

  function localPress() {
    clearTimeout(local.timer);
    if (local.held) return;
    local.held = true;
    S.held = true;
    S.open = true;
    applyGate();
  }

  function localRelease() {
    if (!local.held) return;
    local.held = false;
    S.held = false;
    const d = S.cfg.delay;
    if (d <= 0) {
      S.open = false;
      applyGate();
    } else {
      render();
      local.timer = setTimeout(() => { S.open = false; applyGate(); }, d);
    }
  }

  function finishLocalLearn(binding) {
    S.learning = false;
    if (binding) {
      setCfg({ binding });
      toast('快捷键已设为 ' + bindingName(binding));
    }
    render();
  }

  window.addEventListener('keydown', (e) => {
    if (S.learning) {
      e.preventDefault();
      e.stopPropagation();
      if (S.host || e.repeat) return;
      const vk = vkFromEvent(e);
      if (vk === 27) { finishLocalLearn(null); return; }
      if (isModifierVk(vk)) { local.learnMod = vk; return; }
      finishLocalLearn({ dev: 'kb', code: vk, mods: modsFromEvent(e) });
      return;
    }
    if (!localActive() || e.repeat) return;
    const b = S.cfg.binding;
    if (b.dev === 'kb' && vkFromEvent(e) === b.code && (modsFromEvent(e) & b.mods) === b.mods) localPress();
  }, true);

  window.addEventListener('keyup', (e) => {
    if (S.learning) {
      e.preventDefault();
      e.stopPropagation();
      if (S.host) return;
      const vk = vkFromEvent(e);
      if (local.learnMod && vk === local.learnMod) finishLocalLearn({ dev: 'kb', code: vk, mods: 0 });
      return;
    }
    const b = S.cfg.binding;
    if (localActive() && b.dev === 'kb' && vkFromEvent(e) === b.code) localRelease();
  }, true);

  window.addEventListener('mousedown', (e) => {
    const code = MOUSE_CODE[e.button];
    if (S.learning && !S.host && code) {
      e.preventDefault();
      finishLocalLearn({ dev: 'mouse', code, mods: modsFromEvent(e) });
      return;
    }
    const b = S.cfg.binding;
    if (localActive() && b.dev === 'mouse' && b.code === code) localPress();
  }, true);

  window.addEventListener('mouseup', (e) => {
    const b = S.cfg.binding;
    if (localActive() && b.dev === 'mouse' && b.code === MOUSE_CODE[e.button]) localRelease();
  }, true);

  window.addEventListener('blur', () => { if (local.held) localRelease(); });

  /* ============ 按键名称 ============ */

  const VK_NAMES = {
    0x08: 'Backspace', 0x09: 'Tab', 0x0D: 'Enter', 0x13: 'Pause', 0x14: 'CapsLock', 0x1B: 'Esc', 0x20: '空格',
    0x21: 'PageUp', 0x22: 'PageDown', 0x23: 'End', 0x24: 'Home', 0x25: '←', 0x26: '↑', 0x27: '→', 0x28: '↓',
    0x2C: 'PrintScreen', 0x2D: 'Insert', 0x2E: 'Delete', 0x5B: '左 Win', 0x5C: '右 Win', 0x5D: '菜单键',
    0x6A: 'Num *', 0x6B: 'Num +', 0x6D: 'Num -', 0x6E: 'Num .', 0x6F: 'Num /', 0x90: 'NumLock', 0x91: 'ScrollLock',
    0xA0: '左 Shift', 0xA1: '右 Shift', 0xA2: '左 Ctrl', 0xA3: '右 Ctrl', 0xA4: '左 Alt', 0xA5: '右 Alt',
    0xAD: '静音键', 0xAE: '音量-', 0xAF: '音量+', 0xB0: '下一曲', 0xB1: '上一曲', 0xB2: '停止', 0xB3: '播放/暂停',
    0xBA: ';', 0xBB: '=', 0xBC: ',', 0xBD: '-', 0xBE: '.', 0xBF: '/', 0xC0: '`', 0xDB: '[', 0xDC: '\\', 0xDD: ']', 0xDE: "'",
  };
  const MOUSE_NAMES = { 3: '鼠标中键', 4: '鼠标侧键 1', 5: '鼠标侧键 2' };

  function keyName(vk) {
    if (VK_NAMES[vk]) return VK_NAMES[vk];
    if ((vk >= 0x30 && vk <= 0x39) || (vk >= 0x41 && vk <= 0x5A)) return String.fromCharCode(vk);
    if (vk >= 0x60 && vk <= 0x69) return 'Num ' + (vk - 0x60);
    if (vk >= 0x70 && vk <= 0x87) return 'F' + (vk - 0x6F);
    return '按键 ' + vk;
  }

  function bindingName(b) {
    if (!b) return '未设置';
    const mods = [];
    if (b.mods & 1) mods.push('Ctrl');
    if (b.mods & 2) mods.push('Shift');
    if (b.mods & 4) mods.push('Alt');
    if (b.mods & 8) mods.push('Win');
    const main = b.dev === 'mouse' ? MOUSE_NAMES[b.code] || '鼠标按键' : keyName(b.code);
    return mods.concat(main).join(' + ');
  }

  /* ============ 麦克风实际状态 ============ */

  function micState() {
    const ptt = S.cfg.mode === 'ptt';
    const live = liveTracks();
    if (!live.length) return ptt ? (S.host ? 'armed' : 'offline') : 'none';
    if (!live.some((t) => wants.get(t)) || rtcMuted()) return 'muted';
    if (!gateOpen()) return S.host ? 'armed' : 'offline';
    if (!ptt) return 'talk';
    return S.held ? 'talk' : 'tail';
  }

  /* ============ 读取 Flutter 画布像素 ============ */
  // Oopz 网页版是 Flutter 画布渲染，DOM 里没有任何界面元素，只能通过像素定位。

  const probe = (() => {
    let oc = null;
    let og = null;

    function canvas() {
      const gp = document.querySelector('flt-glass-pane');
      const root = gp && gp.shadowRoot;
      if (!root) return null;
      let best = null;
      for (const c of root.querySelectorAll('canvas')) {
        if (c.width && (!best || c.width * c.height > best.width * best.height)) best = c;
      }
      return best;
    }

    function read(x, y, w, h) {
      const c = canvas();
      if (!c) return null;
      const r = c.getBoundingClientRect();
      if (!r.width || !r.height) return null;
      const s = c.width / r.width;
      const sx = Math.max(0, Math.round((x - r.left) * s));
      const sy = Math.max(0, Math.round((y - r.top) * s));
      const sw = Math.min(c.width - sx, Math.max(1, Math.round(w * s)));
      const sh = Math.min(c.height - sy, Math.max(1, Math.round(h * s)));
      if (sw <= 0 || sh <= 0) return null;
      if (!oc || oc.width < sw || oc.height < sh) {
        oc = new OffscreenCanvas(Math.max(sw, oc ? oc.width : 0), Math.max(sh, oc ? oc.height : 0));
        og = oc.getContext('2d', { willReadFrequently: true });
      }
      og.clearRect(0, 0, sw, sh);
      og.drawImage(c, sx, sy, sw, sh, 0, 0, sw, sh);
      const d = og.getImageData(0, 0, sw, sh).data;
      return {
        d, w: sw, h: sh, s,
        x0: r.left + sx / s,
        y0: r.top + sy / s,
        at(px, py) { const i = (py * sw + px) * 4; return [d[i], d[i + 1], d[i + 2]]; },
      };
    }

    return { canvas, read };
  })();

  const diff = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
  const isAccent = (p) => p[2] > 180 && p[2] - p[0] > 90;
  const luma = (p) => 0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2];

  // 顶栏左侧「麦克风 + 耳机」胶囊里的麦克风图标
  function findMic() {
    const row = probe.read(112, 31, 320, 1);
    if (!row) return null;
    const bg = row.at(0, 0);
    const run = Math.round(8 * row.s);
    let L = -1;
    for (let i = 1; i < row.w - run; i++) {
      const p = row.at(i, 0);
      if (diff(p, bg) < 10) continue;
      let uniform = true;
      for (let j = 1; j <= run; j++) if (diff(row.at(i + j, 0), p) > 6) { uniform = false; break; }
      if (uniform) { L = i; break; }
    }
    if (L < 0) return null;
    const pill = row.at(L, 0);
    let g0 = -1;
    let g1 = -1;
    let gap = 0;
    for (let i = L; i < row.w; i++) {
      if (diff(row.at(i, 0), pill) > 40) {
        if (g0 < 0) g0 = i;
        g1 = i;
        gap = 0;
      } else if (g0 >= 0 && ++gap > Math.round(5 * row.s)) break;
    }
    if (g0 < 0) return null;
    const width = (g1 + 1 - g0) / row.s;
    if (width < 4 || width > 26) return null;
    const cx = row.x0 + (g0 + g1 + 1) / 2 / row.s;
    const left = row.x0 + L / row.s;

    const col = probe.read(left + 3, 0, 1, 70);
    if (!col) return null;
    const mid = Math.round((31 - col.y0) * col.s);
    let top = mid;
    let bottom = mid;
    while (top > 0 && diff(col.at(0, top - 1), pill) < 8) top--;
    while (bottom < col.h - 1 && diff(col.at(0, bottom + 1), pill) < 8) bottom++;
    const cy = col.y0 + (top + bottom + 1) / 2 / col.s;
    return { cx, cy, left, pill, bg };
  }

  // 语音设置页「语音输入模式」下的「自由发言」单选钮
  function findVoiceRadio() {
    const X0 = 270;
    const blk = probe.read(X0, 60, 40, innerHeight - 60);
    if (!blk) return null;
    let st = -1;
    let sumX = 0;
    let n = 0;
    for (let y = 0; y <= blk.h; y++) {
      let rowN = 0;
      let rowX = 0;
      if (y < blk.h) {
        for (let x = 0; x < blk.w; x++) if (isAccent(blk.at(x, y))) { rowN++; rowX += x; }
      }
      if (rowN) {
        if (st < 0) st = y;
        sumX += rowX;
        n += rowN;
      } else if (st >= 0) {
        const h = (y - st) / blk.s;
        if (h >= 5 && h <= 14) {
          const cx = blk.x0 + sumX / n / blk.s;
          const cy = blk.y0 + (st + y) / 2 / blk.s;
          const ci = Math.round((cy - blk.y0) * blk.s);
          const accent = blk.at(Math.round((cx - blk.x0) * blk.s), ci);
          const bg = blk.at(0, Math.max(0, Math.round((cy - 20 - blk.y0) * blk.s)));
          return { cx, cy, accent, bg };
        }
        st = -1; sumX = 0; n = 0;
      }
    }
    return null;
  }

  /* ============ 界面 ============ */

  const FONT = "'oopz-ptt-font', 'PingFang SC', 'Microsoft YaHei UI', 'Microsoft YaHei', sans-serif";

  const CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
.layer { position: fixed; inset: 0; pointer-events: none; z-index: 2147483646; font-family: ${FONT};
  --bg: #121212; --pill: #1e1e1e; --fg1: #dcdcdc; --fg2: #b8b8b8; --fg3: #898989; --line: #4f4f4f; --line2: #6b6b6b;
  --accent: #4fa1ed; --ok: #3ba55c; --warn: #e6a23c; --bad: #ed4245; }
.inline { position: absolute; pointer-events: auto; background: var(--bg); color: var(--fg2); font-size: 14px; display: none; }
.inline.show { display: block; }
.inline .row { position: absolute; left: 0; right: 0; height: 28px; display: flex; align-items: center; white-space: nowrap; }
.radio { display: inline-flex; align-items: center; color: var(--fg2); cursor: pointer; margin-right: 36px; user-select: none; }
.radio i { position: relative; width: 14px; height: 14px; border-radius: 50%; border: 1.6px solid var(--line); margin-right: 9px; flex: none; }
.radio.on i::after { content: ''; position: absolute; left: 1.2px; top: 1.2px; width: 8.4px; height: 8.4px; border-radius: 50%; background: var(--accent); }
.radio:hover i { border-color: var(--line2); }
.hint { color: var(--fg3); }
.hint b { font-weight: normal; color: var(--fg2); }
.dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin-right: 8px; flex: none; }
.h { color: var(--fg1); font-size: 18px; font-weight: normal; }
.lbl { color: var(--fg2); margin-right: 12px; }
.key { height: 28px; min-width: 104px; padding: 0 12px; border-radius: 6px; border: 1px solid var(--line); background: var(--pill);
  color: var(--fg1); font: inherit; font-size: 13px; cursor: pointer; outline: none; }
.key:hover { border-color: var(--line2); }
.key.learn { border-color: var(--accent); color: var(--accent); }
.range { -webkit-appearance: none; appearance: none; width: 150px; height: 16px; margin: 0 12px; background: transparent; cursor: pointer; outline: none; }
.range::-webkit-slider-runnable-track { height: 2px; border-radius: 1px; background: linear-gradient(to right, var(--fg1) var(--p, 0%), var(--line) var(--p, 0%)); }
.range::-webkit-slider-thumb { -webkit-appearance: none; width: 10px; height: 10px; margin-top: -4px; border-radius: 50%; background: var(--fg1); }
.val { color: var(--fg3); min-width: 64px; }
a { color: var(--accent); text-decoration: none; cursor: pointer; }
a:hover { text-decoration: underline; }
.badge { position: absolute; display: none; width: 0; height: 0; }
.badge.show { display: block; }
.badge i { position: absolute; left: 3px; top: 2px; width: 12px; height: 12px; border-radius: 50%; border: 2px solid var(--pill);
  background: #8c8c8c; transition: box-shadow .1s, background-color .15s; }
.mask { position: absolute; inset: 0; pointer-events: auto; background: rgba(0,0,0,.45); display: none; align-items: center; justify-content: center; }
.mask.show { display: flex; }
.card { width: 600px; max-width: calc(100vw - 32px); background: var(--pill); border: 1px solid #2c2c2c; border-radius: 12px;
  box-shadow: 0 12px 40px rgba(0,0,0,.45); padding: 20px 24px 22px; color: var(--fg2); font-size: 14px; }
.card .top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; }
.card .x { width: 28px; height: 28px; border: 0; border-radius: 6px; background: transparent; color: var(--fg3); font-size: 18px; cursor: pointer; }
.card .x:hover { background: rgba(255,255,255,.06); color: var(--fg1); }
.card .row { display: flex; align-items: center; min-height: 28px; white-space: nowrap; margin-bottom: 6px; }
.card .row.h { margin-top: 18px; margin-bottom: 8px; }
.card .row.hint { white-space: normal; line-height: 20px; }
.toast { position: absolute; left: 50%; bottom: 48px; transform: translateX(-50%); background: rgba(30,30,30,.96); color: var(--fg1);
  border: 1px solid #333; border-radius: 8px; padding: 8px 14px; font-size: 13px; opacity: 0; transition: opacity .2s; pointer-events: none; }
.toast.show { opacity: 1; }
.light .card { border-color: #e2e2e2; box-shadow: 0 12px 40px rgba(0,0,0,.15); }
.light .toast { background: rgba(255,255,255,.98); border-color: #ddd; }
`;

  // 相对「自由发言」单选钮圆心的纵向位置，按 Oopz 1.4.x 实测
  const ROW = { radio: 0, hint: 29, header: 96, keys: 128 };

  function buildControls(el, inline) {
    el.innerHTML = `
      <div class="row r-mode"><span class="radio" data-mode="free"><i></i>自由发言</span><span class="radio" data-mode="ptt"><i></i>按键说话</span></div>
      <div class="row r-hint hint"></div>
      <div class="row r-head h">快捷键</div>
      <div class="row r-keys"><span class="lbl">按键说话</span><button class="key" type="button"></button>
        <span class="lbl" style="margin-left:28px">释放延迟</span><input class="range" type="range" min="0" max="1000" step="10"><span class="val"></span></div>`;
    const $ = (s) => el.querySelector(s);
    const radios = el.querySelectorAll('.radio');
    const hint = $('.r-hint');
    const keyBtn = $('.key');
    const range = $('.range');
    const val = $('.val');

    radios.forEach((r) => r.addEventListener('click', () => {
      const mode = r.dataset.mode;
      if (mode === S.cfg.mode) return;
      setCfg({ mode });
      if (mode === 'ptt' && !S.cfg.binding) startLearn();
    }));
    keyBtn.addEventListener('click', () => (S.learning ? cancelLearn() : startLearn()));
    keyBtn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (S.cfg.binding) setCfg({ binding: null });
    });
    let sendTimer = 0;
    range.addEventListener('input', () => {
      const v = range.value | 0;
      val.textContent = v + ' 毫秒';
      range.style.setProperty('--p', (v / 10) + '%');
      clearTimeout(sendTimer);
      sendTimer = setTimeout(() => setCfg({ delay: v }), 150);
    });

    let lastRange = -1;
    return function update() {
      radios.forEach((r) => r.classList.toggle('on', r.dataset.mode === S.cfg.mode));
      keyBtn.classList.toggle('learn', S.learning);
      keyBtn.textContent = S.learning ? '请按下按键…（Esc 取消）' : bindingName(S.cfg.binding);
      keyBtn.title = S.cfg.binding ? '点击重新录制，右键清除' : '点击录制快捷键，支持键盘和鼠标中键、侧键';
      if (document.activeElement !== range && el.getRootNode().activeElement !== range && lastRange !== S.cfg.delay) {
        lastRange = S.cfg.delay;
        range.value = S.cfg.delay;
        range.style.setProperty('--p', (S.cfg.delay / 10) + '%');
        val.textContent = S.cfg.delay + ' 毫秒';
      }
      hint.innerHTML = statusHtml(inline);
    };
  }

  function statusHtml(inline) {
    const ptt = S.cfg.mode === 'ptt';
    if (S.host) {
      const v = S.hostVersion ? ` v${S.hostVersion}` : '';
      return `<span class="dot" style="background:var(--ok)"></span>本地助手已连接${v}，` +
        (ptt ? `在任何程序中按住&nbsp;<b>${esc(bindingName(S.cfg.binding))}</b>&nbsp;即可说话` : '选择按键说话后，按住快捷键才会发送声音');
    }
    const warn = '<span class="dot" style="background:var(--warn)"></span>';
    if (TRANSPORT === 'ws' && lna === 'denied') {
      return warn + '浏览器拦截了本页对本机程序的访问，请在网站设置中允许「本设备上的应用」后刷新';
    }
    if (TRANSPORT === 'ws' && lna === 'prompt') {
      return warn + '如果浏览器询问是否允许访问本设备上的应用，请选择「允许」';
    }
    const dl = `<a href="${HOME_URL}/releases/latest" target="_blank" rel="noopener">下载本地助手</a>`;
    return warn + '未连接本地助手，快捷键只在本页面处于前台时有效。' + (inline ? dl : '运行 OopzPtt.exe 后自动连接，' + dl);
  }

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function startLearn() {
    S.learning = true;
    local.learnMod = 0;
    if (S.host) send({ t: 'learn' });
    clearTimeout(startLearn.timer);
    startLearn.timer = setTimeout(() => { if (S.learning) cancelLearn(); }, 15000);
    render();
  }

  function cancelLearn() {
    S.learning = false;
    if (S.host) send({ t: 'learnCancel' });
    render();
  }

  let ui = null;

  function createUi() {
    const hostEl = document.createElement('oopz-ptt');
    const root = hostEl.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>${CSS}</style>
      <div class="layer">
        <div class="badge"><i></i></div>
        <div class="inline"></div>
        <div class="mask"><div class="card"><div class="top"><span class="h">按键说话</span><button class="x" type="button" title="关闭">×</button></div><div class="body"></div></div></div>
        <div class="toast"></div>
      </div>`;
    document.documentElement.appendChild(hostEl);

    const layer = root.querySelector('.layer');
    const badge = root.querySelector('.badge');
    const badgeDot = badge.querySelector('i');
    const inline = root.querySelector('.inline');
    const mask = root.querySelector('.mask');
    const card = root.querySelector('.card');
    const toastEl = root.querySelector('.toast');

    const updInline = buildControls(inline, true);
    const updModal = buildControls(card.querySelector('.body'), false);
    // 面板顶部 = 圆心 - 14，每行高 28，所以行的 top 就等于该行中心相对圆心的偏移
    const rows = inline.querySelectorAll('.row');
    [ROW.radio, ROW.hint, ROW.header, ROW.keys].forEach((y, i) => { rows[i].style.top = y + 'px'; });

    for (const el of [inline, mask]) {
      for (const t of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu', 'keydown', 'keyup']) {
        el.addEventListener(t, (e) => e.stopPropagation());
      }
    }
    // 面板盖住了 Flutter，滚轮转发回去，让设置页照常滚动
    inline.addEventListener('wheel', (e) => {
      e.preventDefault();
      e.stopPropagation();
      hideInline();
      scheduleScan(220);
      const fv = document.querySelector('flutter-view');
      if (fv) {
        fv.dispatchEvent(new WheelEvent('wheel', {
          deltaX: e.deltaX, deltaY: e.deltaY, deltaMode: e.deltaMode, clientX: e.clientX, clientY: e.clientY,
          screenX: e.screenX, screenY: e.screenY, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, bubbles: true, cancelable: true, composed: true,
        }));
      }
    }, { passive: false });
    mask.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });
    mask.addEventListener('click', (e) => { if (e.target === mask) closeModal(); });
    card.querySelector('.x').addEventListener('click', closeModal);
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && mask.classList.contains('show') && !S.learning) closeModal();
    }, true);

    let anchorVoice = null;
    let anchorMic = null;

    function applyTheme(bg, pill, accent) {
      const light = luma(bg) > 140;
      layer.classList.toggle('light', light);
      const set = (k, v) => layer.style.setProperty(k, v);
      const rgb = (p) => `rgb(${p[0]},${p[1]},${p[2]})`;
      set('--bg', rgb(bg));
      if (pill) set('--pill', rgb(pill));
      if (accent) set('--accent', rgb(accent));
      set('--fg1', light ? '#1f1f1f' : '#dcdcdc');
      set('--fg2', light ? '#4a4a4a' : '#b8b8b8');
      set('--fg3', light ? '#8c8c8c' : '#898989');
      set('--line', light ? '#c4c4c4' : '#4f4f4f');
      set('--line2', light ? '#9a9a9a' : '#6b6b6b');
    }

    function place() {
      if (anchorMic) {
        badge.style.left = anchorMic.cx + 'px';
        badge.style.top = anchorMic.cy + 'px';
      }
      if (anchorVoice) {
        const left = anchorVoice.cx - 7;
        inline.style.left = left + 'px';
        inline.style.top = (anchorVoice.cy - 14) + 'px';
        inline.style.width = Math.max(420, Math.min(600, innerWidth - left - 24)) + 'px';
        inline.style.height = (ROW.keys + 30) + 'px';
        inline.classList.add('show');
      } else {
        hideInline();
      }
      update();
    }

    function hideInline() {
      inline.classList.remove('show');
    }

    function setAnchors(mic, voice) {
      anchorMic = mic;
      anchorVoice = voice;
      const bg = (voice && voice.bg) || (mic && mic.bg);
      if (bg) applyTheme(bg, mic && mic.pill, voice && voice.accent);
      place();
    }

    function update() {
      const st = micState();
      const show = !!anchorMic && st !== 'none';
      badge.classList.toggle('show', show);
      if (show) {
        const color = { talk: 'var(--ok)', tail: 'var(--ok)', muted: 'var(--bad)', offline: 'var(--warn)', armed: '#8c8c8c' }[st];
        badgeDot.style.background = color;
        const glow = st === 'talk' || st === 'tail' ? Math.round(2 + S.level * 6) : 0;
        badgeDot.style.boxShadow = glow ? `0 0 0 ${glow}px rgba(59,165,92,${st === 'tail' ? 0.18 : 0.32})` : 'none';
      }
      if (inline.classList.contains('show')) updInline();
      if (mask.classList.contains('show')) updModal();
    }

    function openModal() {
      mask.classList.add('show');
      update();
    }

    function closeModal() {
      if (S.learning) cancelLearn();
      mask.classList.remove('show');
    }

    let toastTimer = 0;
    function showToast(text) {
      toastEl.textContent = text;
      toastEl.classList.add('show');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2200);
    }

    return {
      update, setAnchors, hideInline, openModal, showToast,
      get anchorMic() { return anchorMic; },
      get anchorVoice() { return anchorVoice; },
    };
  }

  function toast(text) {
    if (ui) ui.showToast(text);
  }

  let renderQueued = false;
  function render() {
    if (renderQueued || !ui) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      ui.update();
    });
  }

  /* ============ 定位扫描 ============ */

  let scanTimer = 0;

  function scan() {
    if (!ui) return;
    let mic = null;
    let voice = null;
    try { mic = findMic(); } catch (e) { }
    try { voice = findVoiceRadio(); } catch (e) { }
    ui.setAnchors(mic, voice);
  }

  function scheduleScan(delay) {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, delay);
  }

  // 每秒核对一次锚点像素，页面切走就收起；没找到顶栏时降到每 3 秒找一次
  let verifyTick = 0;
  function verify() {
    if (!ui || document.hidden) return;
    const v = ui.anchorVoice;
    const m = ui.anchorMic;
    if (!m && !v && ++verifyTick % 3 !== 0) return;
    let stale = false;
    try {
      if (v) {
        const p = probe.read(v.cx, v.cy, 1, 1);
        if (!p || !isAccent(p.at(0, 0))) stale = true;
      }
      if (m) {
        const p = probe.read(m.left + 2, m.cy, 1, 1);
        if (!p || diff(p.at(0, 0), m.pill) > 8) stale = true;
      } else {
        stale = true;
      }
    } catch (e) { stale = true; }
    if (stale) scan();
  }

  async function loadFont() {
    try {
      const entry = performance.getEntriesByType('resource').find((r) => /\/FontManifest\.json(\?|$)/.test(r.name));
      if (!entry) return false;
      const list = await fetch(entry.name).then((r) => r.json());
      const fam = list.find((f) => f.family === 'web_font');
      const asset = fam && fam.fonts && fam.fonts[0] && fam.fonts[0].asset;
      if (asset) {
        const face = new FontFace('oopz-ptt-font', `url("${new URL(asset, entry.name).href}")`);
        document.fonts.add(face);
        face.load().catch(() => { });
      }
      return true;
    } catch (e) {
      return true;
    }
  }

  function start() {
    if (ui) return;
    ui = createUi();

    const onPointerUp = () => { scheduleScan(250); setTimeout(scan, 900); };
    window.addEventListener('pointerup', onPointerUp, true);
    window.addEventListener('keyup', () => scheduleScan(300), true);
    window.addEventListener('wheel', (e) => {
      if (e.composedPath().some((n) => n && n.tagName === 'OOPZ-PTT')) return;
      ui.hideInline();
      scheduleScan(220);
    }, { capture: true, passive: true });
    window.addEventListener('resize', () => { ui.hideInline(); scheduleScan(300); });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) scheduleScan(300); });
    setInterval(verify, 1000);

    let fontTries = 0;
    const tryFont = () => loadFont().then((done) => { if (!done && ++fontTries < 20) setTimeout(tryFont, 1500); });
    tryFont();
    scheduleScan(500);
  }

  // 等 Flutter 画出第一帧再挂界面；页面结构变了也在 10 秒后挂上，至少保证托盘里的「打开设置」可用
  const bootAt = Date.now();
  function waitForFlutter() {
    if (probe.canvas() || Date.now() - bootAt > 10000) start();
    else setTimeout(waitForFlutter, 500);
  }

  connect();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', waitForFlutter, { once: true });
  else waitForFlutter();
})();
