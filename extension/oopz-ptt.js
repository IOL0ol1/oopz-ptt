// Oopz 按键说话 - 页面脚本
// 扩展以 MAIN world 注入；油猴脚本使用同一份代码（构建时把 TRANSPORT 改成 ws）。
//
// 分区（自上而下，依赖单向）：
//   常量 → 单实例守卫 → 运行时状态 → 工具 → 广告拦截 → 配置 → 麦克风闸门
//   → RTC 旁听 → 传输 → 页面内按键 → 按键名称 → 像素探针 → 定位 → 状态机
//   → 界面 → 扫描巡检 → 启动
(() => {
  'use strict';

  /* ════════════════════ 构建常量 ════════════════════ */

  const VERSION = '0.2.8';
  // 扩展为 bridge（经扩展后台转发，不触发浏览器的本地网络授权提示）
  // 油猴脚本构建时替换为 ws（页面直接连本地助手）
  const TRANSPORT = 'bridge';
  const BRIDGE_TAG = '__oopzPtt';
  const IS_BRIDGE = TRANSPORT === 'bridge';
  const IS_WS = !IS_BRIDGE;

  const HOST_URL = 'ws://127.0.0.1:29271/';
  const HOME_URL = 'https://github.com/IOL0ol1/oopz-ptt';
  const STORE_KEY = 'oopz-ptt';

  /* ════════════════════ 单实例守卫 ════════════════════ */
  // 扩展和油猴脚本可以同时安装：两者注入同一份脚本、同一个 world，只让先到的一方生效，
  // 后来的一方让位并清掉自己可能已建立的连接，避免出现两套界面或一条没人接收的助手连接。
  if (window.__oopzPtt) {
    if (IS_BRIDGE) {
      window.__oopzPttExt = VERSION;
      try { window.postMessage({ [BRIDGE_TAG]: 'release' }, location.origin); } catch (e) { }
    } else {
      window.__oopzPttUser = VERSION;
    }
    return;
  }

  /* ════════════════════ 运行时状态 ════════════════════ */

  const S = {
    cfg: { mode: 'free', binding: null, delay: 200 },
    dirty: false,        // 与助手未连接时改过配置，连上后补发
    host: false,
    hostVersion: '',
    held: false,         // 快捷键是否按住
    open: false,         // 麦克风闸门是否放行（按下 + 释放延迟期内）
    learning: false,
    level: 0,            // 实际发送的音量 0~1，用于绿点外发光
  };

  window.__oopzPtt = { version: VERSION, state: S, transport: TRANSPORT };

  // 声明本侧身份，供对方让位时识别。bridge.js 是惰性的，收到 want 才连助手。
  if (IS_BRIDGE) {
    window.__oopzPttExt = VERSION;
    try { window.postMessage({ [BRIDGE_TAG]: 'want' }, location.origin); } catch (e) { }
  } else {
    window.__oopzPttUser = VERSION;
  }

  /* ════════════════════ 定位与显示参数 ════════════════════ */
  // 所有与 Oopz 画面坐标相关的常量集中在这里。Oopz 改版或窗口缩放异常时只调这一处。
  const LOCATE = {
    // 顶栏「麦克风 + 耳机 + 挂断」胶囊的横向扫描行。x 不能写死到图标上：
    // 窗口缩放不是 100% 时整个顶栏会平移，写死会扫到耳机甚至头像。
    micRow: { x: 112, y: 31, w: 320 },
    // 以图标中心为基准的纵向投影窗口（左右各 5px、从 y=18 起 26px 高）
    micBox: { dx: -5, y: 18, w: 11, h: 26 },
    // 圆点写死坐标。实测（2560x1440、页面缩放约 1.28）：房外图标 cx≈201、房内≈169，top 一致。
    // 换分辨率/缩放或 Oopz 改版后这两个值需要重新实测。
    badge: { top: 38, out: 207, in: 175 },
    // 房内外分界：图标 cx 小于此值视为在房间内（169 房内 / 201 房外，取中点）
    inRoomMaxCx: 185,
    // 语音设置页「语音输入模式」单选钮的扫描区域
    voiceBlock: { x: 270, y: 60, w: 64 },
    // 面板各行相对「自由发言」单选钮圆心的纵向偏移，按 Oopz 1.4.x 实测
    panelRows: { radio: 0, hint: 29, header: 96, keys: 128 },
  };

  // 圆点只有三态
  const STATE_COLOR = { talk: '#67dd0d', muted: 'var(--bad)', armed: '#8c8c8c' };

  /* ════════════════════ 通用工具 ════════════════════ */

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const diff = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
  const isAccent = (p) => p[2] > 180 && p[2] - p[0] > 90;
  const luma = (p) => 0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2];
  // 饱和度：设置页背景是中性灰，彩色卡片（活动 banner、广告位）饱和度很高
  const chroma = (p) => Math.max(p[0], p[1], p[2]) - Math.min(p[0], p[1], p[2]);

  /* ════════════════════ 屏蔽首页广告接口 ════════════════════ */
  // 开屏推广浮层和首页横幅都由 /advertisement/v2/list 下发，整块画在 Flutter 画布上，
  // DOM 里没有节点可删、也没有「浮层出现」事件可监听，只能在数据源头截断。
  // 按网络失败处理，页面已验证能正常降级。

  (() => {
    const AD_URL = /\/advertisement\/v\d+\/list/;

    try {
      const origFetch = window.fetch;
      if (typeof origFetch === 'function') {
        window.fetch = function (input) {
          const url = typeof input === 'string' ? input : input && input.url;
          if (url && AD_URL.test(url)) return Promise.reject(new TypeError('Failed to fetch'));
          return origFetch.apply(this, arguments);
        };
      }
    } catch (e) { }

    try {
      const XO = XMLHttpRequest.prototype.open;
      const XS = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function (method, url) {
        try { this.__oopzAd = AD_URL.test(String(url)); } catch (e) { }
        return XO.apply(this, arguments);
      };
      XMLHttpRequest.prototype.send = function () {
        if (!this.__oopzAd) return XS.apply(this, arguments);
        try {
          Object.defineProperty(this, 'readyState', { configurable: true, get: () => 4 });
          Object.defineProperty(this, 'status', { configurable: true, get: () => 0 });
        } catch (e) { }
        setTimeout(() => {
          for (const t of ['readystatechange', 'error', 'loadend']) {
            try { this.dispatchEvent(new ProgressEvent(t)); } catch (e) { }
          }
        }, 0);
        return undefined;
      };
    } catch (e) { }
  })();

  /* ════════════════════ 配置 ════════════════════ */
  // 本地缓存用于页面刷新后立即可用；连接上助手后以助手的配置为准（助手是权威）。
  // 这里的归一化只做容错，规则必须与 host/Settings.cs 的 Normalize 保持一致。

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
    if (!S.host) pageReset();
    applyGate();
  }

  loadCfg();

  /* ════════════════════ 麦克风闸门 ════════════════════ */
  // 只改原始采集轨道的 enabled。对页面暴露的 enabled 仍是 Oopz 自己设置的值，
  // 实际启用 = 页面的值 && 闸门，所以不会覆盖 Oopz 自己的闭麦逻辑。

  const enabledDesc = Object.getOwnPropertyDescriptor(MediaStreamTrack.prototype, 'enabled');
  const tracks = new Set();
  const wants = new WeakMap();   // track → Oopz 想设置的值

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
        schedulePaint();
      },
    });
    tracks.add(track);
    enabledDesc.set.call(track, wants.get(track) && gateOpen());
    track.addEventListener('ended', () => { tracks.delete(track); schedulePaint(); });
    schedulePaint();
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
    schedulePaint();
  }

  function adoptStream(stream) {
    try {
      if (!stream || typeof stream.getAudioTracks !== 'function') return;
      const arr = stream.getAudioTracks();
      for (let i = 0; i < arr.length; i++) adopt(arr[i]);
    } catch (e) { }
  }

  // Oopz 的 trtc.js / iris-web-rtc 会把 getUserMedia 覆盖成 navigator.mediaDevices 的
  // 实例自有属性，绕过原型补丁。所以不在 getUserMedia 本身做包装（SDK 会读回包装函数
  // 再包一层，形成递归），改为在「轨道被真正使用」的层面接管：SDK 无论怎么采集，
  // 最终都要取 audio track 并加进 RTC 连接。

  const origGetUserMedia = MediaDevices.prototype.getUserMedia;
  MediaDevices.prototype.getUserMedia = function (constraints) {
    return origGetUserMedia.call(this, constraints).then((stream) => {
      adoptStream(stream);
      return stream;
    });
  };

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

  // SDK 若绕过 getUserMedia 且直接持有 track，这里仍能拦到最终进入连接的那一路。
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

  /* ════════════════════ 音量（绿点外发光） ════════════════════ */
  // 分析"实际在发送"的那一路轨道：页面 want 为真且闸门放行。这样静音或被闸门关掉时
  // 电平自然是 0，不会出现"没在发声音、光晕却在跳"。
  // AudioContext 受浏览器自动播放策略限制，用户交互前是 suspended，此时电平保持 0。

  let actx = null;
  let analyser = null;
  let meterTrack = null;
  let meterNode = null;
  let meterBuf = null;

  function meterTick() {
    const t = liveTracks().find((x) => wants.get(x) && gateOpen()) || null;
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
    if (ui) ui.setLevel(level);
  }

  setInterval(meterTick, 100);

  /* ════════════════════ 旁听 RTC，判断 Oopz 自己是否闭麦 ════════════════════ */

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
      schedulePaint();
      return;
    }
    if (!key) return;
    try {
      const d = JSON.parse(p.data);
      if (field in d) {
        rtcMute[key] = invert ? !d[field] : !!d[field];
        schedulePaint();
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
        if (o && typeof o === 'object' && 'mute' in o) { rtcMute.trtc = !!o.mute; schedulePaint(); }
        return upd.apply(this, arguments);
      };
    }
    for (const m of ['exitRoom', 'stopLocalAudio']) {
      const f = inst[m];
      if (typeof f === 'function') {
        inst[m] = function () {
          delete rtcMute.trtc;
          schedulePaint();
          return f.apply(this, arguments);
        };
      }
    }
  }

  setInterval(hookRtc, 1500);

  /* ════════════════════ 与本地助手的传输 ════════════════════ */
  // 两种实现共用一组回调：onUp（连上）/ onDown（断开）/ onMessage（业务消息）。
  // 扩展走 bridge.js 转发（页面不需要本地网络权限），油猴由页面直连并处理重连与授权探测。

  let ws = null;
  let retryCount = 0;
  let retryTimer = 0;
  let lna = '';   // 浏览器「访问本设备上的应用」权限状态，仅 ws 模式使用

  function createTransport() {
    if (IS_BRIDGE) {
      return {
        send(msg) {
          try { window.postMessage({ [BRIDGE_TAG]: 'out', m: msg }, location.origin); } catch (e) { }
          // bridge 是异步转发，无法立刻得知是否送达；已连接即视为送达
          return S.host || msg.t === 'hello';
        },
        start(onUp, onDown, onMessage) {
          window.addEventListener('message', (e) => {
            if (e.source !== window || !e.data || e.data[BRIDGE_TAG] !== 'in') return;
            const m = e.data.m;
            if (!m || typeof m.t !== 'string') return;
            if (m.t === '__up') onUp();
            else if (m.t === '__down') onDown();
            else onMessage(m);
          });
        },
      };
    }

    return {
      send(msg) {
        if (!ws || ws.readyState !== 1) return false;
        ws.send(JSON.stringify(msg));
        return true;
      },
      start(onUp, onDown, onMessage) {
        const connect = () => {
          clearTimeout(retryTimer);
          let sock;
          try { sock = new WebSocket(HOST_URL); } catch (e) { reconnect(); return; }
          ws = sock;
          sock.onopen = () => { retryCount = 0; onUp(); };
          sock.onmessage = (e) => {
            let m;
            try { m = JSON.parse(e.data); } catch (err) { return; }
            onMessage(m);
          };
          sock.onclose = () => {
            if (ws !== sock) return;
            ws = null;
            onDown();
            reconnect();
          };
          sock.onerror = () => { };
        };
        const reconnect = () => {
          retryCount = Math.min(retryCount + 1, 8);
          retryTimer = setTimeout(connect, Math.min(1000 * retryCount, 8000));
          checkLna();
        };
        connect();
      },
    };
  }

  const transport = createTransport();

  function send(msg) {
    return transport.send(msg);
  }

  // 查询浏览器是否拦截了对本机的访问，用于界面提示（仅 ws 模式会有意义）
  async function checkLna() {
    for (const name of ['loopback-network', 'local-network-access']) {
      try {
        const st = (await navigator.permissions.query({ name })).state;
        if (st !== lna) { lna = st; schedulePaint(); }
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

  function onHostMessage(m) {
    switch (m.t) {
      case 'state': {
        const first = !S.host;
        S.host = true;
        S.hostVersion = m.v || '';
        pageReset();
        if (first && S.dirty) {
          // 离线期间的改动在首次连上时补发给助手
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
        schedulePaint();
        break;
      case 'learnEnd':
        S.learning = false;
        schedulePaint();
        break;
    }
  }

  /* ════════════════════ 页面内按键（助手未连接时的退路） ════════════════════ */

  const pageKey = { held: false, timer: 0, learnMod: 0 };

  function pageReset() {
    clearTimeout(pageKey.timer);
    if (pageKey.held || (!S.host && S.open)) {
      pageKey.held = false;
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

  function pageActive() {
    return !S.host && S.cfg.mode === 'ptt' && !!S.cfg.binding;
  }

  function pagePress() {
    clearTimeout(pageKey.timer);
    if (pageKey.held) return;
    pageKey.held = true;
    S.held = true;
    S.open = true;
    applyGate();
  }

  function pageRelease() {
    if (!pageKey.held) return;
    pageKey.held = false;
    S.held = false;
    const d = S.cfg.delay;
    if (d <= 0) {
      S.open = false;
      applyGate();
    } else {
      schedulePaint();
      pageKey.timer = setTimeout(() => { S.open = false; applyGate(); }, d);
    }
  }

  function finishPageLearn(binding) {
    S.learning = false;
    if (binding) {
      setCfg({ binding });
      toast('快捷键已设为 ' + bindingName(binding));
    }
    schedulePaint();
  }

  window.addEventListener('keydown', (e) => {
    if (S.learning) {
      e.preventDefault();
      e.stopPropagation();
      if (S.host || e.repeat) return;
      const vk = vkFromEvent(e);
      if (vk === 27) { finishPageLearn(null); return; }
      if (isModifierVk(vk)) { pageKey.learnMod = vk; return; }
      finishPageLearn({ dev: 'kb', code: vk, mods: modsFromEvent(e) });
      return;
    }
    if (!pageActive() || e.repeat) return;
    const b = S.cfg.binding;
    if (b.dev === 'kb' && vkFromEvent(e) === b.code && (modsFromEvent(e) & b.mods) === b.mods) pagePress();
  }, true);

  window.addEventListener('keyup', (e) => {
    if (S.learning) {
      e.preventDefault();
      e.stopPropagation();
      if (S.host) return;
      const vk = vkFromEvent(e);
      if (pageKey.learnMod && vk === pageKey.learnMod) finishPageLearn({ dev: 'kb', code: vk, mods: 0 });
      return;
    }
    const b = S.cfg.binding;
    if (pageActive() && b.dev === 'kb' && vkFromEvent(e) === b.code) pageRelease();
  }, true);

  window.addEventListener('mousedown', (e) => {
    const code = MOUSE_CODE[e.button];
    if (S.learning && !S.host && code) {
      e.preventDefault();
      finishPageLearn({ dev: 'mouse', code, mods: modsFromEvent(e) });
      return;
    }
    const b = S.cfg.binding;
    if (pageActive() && b.dev === 'mouse' && b.code === code) pagePress();
  }, true);

  window.addEventListener('mouseup', (e) => {
    const b = S.cfg.binding;
    if (pageActive() && b.dev === 'mouse' && b.code === MOUSE_CODE[e.button]) pageRelease();
  }, true);

  window.addEventListener('blur', () => { if (pageKey.held) pageRelease(); });

  /* ════════════════════ 按键名称 ════════════════════ */

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

  /* ════════════════════ 像素探针 ════════════════════ */
  // Oopz 网页版是 Flutter 画布渲染，DOM 里没有可查询的控件，界面定位只能读画布像素。

  const probe = (() => {
    let cached = null;
    let oc = null;
    let og = null;

    function canvas() {
      if (cached && cached.isConnected && cached.width) return cached;
      const gp = document.querySelector('flt-glass-pane');
      const root = gp && gp.shadowRoot;
      if (!root) return null;
      let best = null;
      for (const c of root.querySelectorAll('canvas')) {
        if (c.width && (!best || c.width * c.height > best.width * best.height)) best = c;
      }
      cached = best;
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

  /* ════════════════════ 定位结果 ════════════════════ */
  // 唯一真相：状态机与界面都从这里读，不再依赖 UI 闭包里的变量。

  const loc = { mic: null, voice: null };

  const inRoom = () => !!(loc.mic && loc.mic.cx < LOCATE.inRoomMaxCx);

  /* ════════════════════ 顶栏麦克风图标 ════════════════════ */
  // 图标是细线轮廓、内部空心，颜色随静音/开麦变化，既不能找连续色块也不能靠颜色识别。
  // 定位分三步：
  //   1. 在固定行横扫，找胶囊左边界（胶囊底色是一段均匀色块）
  //   2. 从胶囊左边界起做列投影，第一个足够宽的列簇就是麦克风图标 → 得到 cx
  //   3. 以 cx 为中心做多行投影，求图标上下边界与静音形态
  // 图标 x 不能写死：窗口缩放不是 100% 时整个顶栏会平移。

  function findMic() {
    const row = probe.read(LOCATE.micRow.x, LOCATE.micRow.y, LOCATE.micRow.w, 1);
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

    // 第一个足够宽的图标像素段，过窄的视为噪点
    const tol = 26;
    const maxGap = Math.round(3 * row.s);
    const minW = Math.round(5 * row.s);
    let g0 = -1;
    let g1 = -1;
    let gap = 0;
    for (let i = L; i < row.w; i++) {
      if (diff(row.at(i, 0), pill) > tol) {
        if (g0 < 0) g0 = i;
        g1 = i;
        gap = 0;
      } else if (g0 >= 0 && ++gap > maxGap) {
        if (g1 + 1 - g0 >= minW) break;
        g0 = -1; g1 = -1; gap = 0;
      }
    }
    if (g0 < 0 || g1 < 0) return null;
    const w = (g1 + 1 - g0) / row.s;
    if (w < 4 || w > 26) return null;
    const cx = row.x0 + (g0 + g1 + 1) / 2 / row.s;
    const left = row.x0 + L / row.s;

    // 多行投影求上下边界。单列扫描穿过图标空心处会得到 h=1 的假值。
    const B = LOCATE.micBox;
    const box = probe.read(cx + B.dx, B.y, B.w, B.h);
    if (!box) return null;
    const rowHits = [];
    for (let y = 0; y < box.h; y++) {
      let hit = 0;
      for (let x = 0; x < box.w; x++) if (diff(box.at(x, y), pill) > 22) hit++;
      rowHits.push(hit);
    }
    // 取连续命中段（忽略零散噪点），阈值取列宽的 1/4
    const need = Math.max(1, Math.floor(box.w / 4));
    let top = -1, bottom = -1, runStart = -1;
    for (let y = 0; y <= rowHits.length; y++) {
      const on = y < rowHits.length && rowHits[y] >= need;
      if (on && runStart < 0) runStart = y;
      if (!on && runStart >= 0) {
        if (y - runStart >= 2) { if (top < 0) top = runStart; bottom = y - 1; }
        runStart = -1;
      }
    }

    let cy, h;
    let iconMuted = false;
    if (top >= 0) {
      cy = box.y0 + (top + bottom + 1) / 2 / box.s;
      h = (bottom + 1 - top) / box.s;
      // 静音识别：开麦时话筒主体内部空心、静音时有一条斜杠穿过。
      // 取主体中心第 3~6 行的命中数（11 列宽实测：开麦≈2、静音≈4）。
      // 顶部两行是麦克风网格帽子，两种状态命中都高，不能当基准。
      let mid = 0, n = 0;
      for (let y = top + 3; y <= Math.min(top + 6, bottom); y++) { mid += rowHits[y]; n++; }
      mid = n ? mid / n : 0;
      iconMuted = mid >= box.w * 0.28;
    } else {
      cy = 31; h = 0;   // 兜底：顶栏图标中心常在 y≈31
    }
    return { cx, cy, left, pill, bg, w, h, iconMuted };
  }

  /* ════════════════════ 语音设置页「自由发言」单选钮 ════════════════════ */
  // 单选钮是直径 5~14px 的孤立圆点。必须严格校验几何：只放宽高会让主界面左上角
  // 任意一块蓝色小图形（头像、状态点、图标）被误认，面板就会弹在错误位置。
  // 额外要求宽高比接近 1、左右留白充足、上下留白，排除大图标内部的小蓝块。

  function findVoiceRadio() {
    const V = LOCATE.voiceBlock;
    const blk = probe.read(V.x, V.y, V.w, innerHeight - V.y);
    if (!blk) return null;
    const pad = Math.max(2, Math.round(5 * blk.s));
    let st = -1;
    let minX = Infinity;
    let maxX = -1;
    for (let y = 0; y <= blk.h; y++) {
      let rowMin = Infinity;
      let rowMax = -1;
      if (y < blk.h) {
        for (let x = 0; x < blk.w; x++) {
          if (isAccent(blk.at(x, y))) {
            if (x < rowMin) rowMin = x;
            if (x > rowMax) rowMax = x;
          }
        }
      }
      if (rowMax >= 0) {
        if (st < 0) { st = y; minX = rowMin; maxX = rowMax; }
        if (rowMin < minX) minX = rowMin;
        if (rowMax > maxX) maxX = rowMax;
      } else if (st >= 0) {
        const h = (y - st) / blk.s;
        const w = (maxX + 1 - minX) / blk.s;
        const ratio = w / h;
        const isolated = minX >= pad && (blk.w - 1 - maxX) >= pad;
        if (h >= 5 && h <= 14 && w >= 4 && w <= 20 && ratio >= 0.55 && ratio <= 1.9 && isolated) {
          const px = Math.round((minX + maxX) / 2);
          const ci = Math.round((st + y) / 2);
          // 背景取左侧留白，避免取样点落在别的图形上（会把主题染成那块图形的颜色）
          const bg = blk.at(Math.max(0, minX - pad - 1), ci);
          // 背景必须是中性色：设置页是灰阶底，主界面的彩色卡片里的小图标不能当单选钮
          if (chroma(bg) > 36) { st = -1; minX = Infinity; maxX = -1; continue; }
          // 上下留白：单选钮所在行上下都应是背景；大图标内部的小蓝块过不了这一关
          const gap = Math.max(3, Math.round(5 * blk.s));
          const up = st - gap;
          const dn = y + gap;
          const upOk = up < 0 || diff(blk.at(px, up), bg) < 26;
          const dnOk = dn >= blk.h || diff(blk.at(px, dn), bg) < 26;
          if (upOk && dnOk) {
            const cx = blk.x0 + (minX + maxX + 1) / 2 / blk.s;
            const cy = blk.y0 + (st + y) / 2 / blk.s;
            const accent = blk.at(px, ci);
            return { cx, cy, accent, bg };
          }
        }
        st = -1; minX = Infinity; maxX = -1;
      }
    }
    return null;
  }

  /* ════════════════════ 麦克风状态机（纯函数） ════════════════════ */
  // 圆点三态：talk(绿) / armed(灰) / muted(红)
  //   禁用麦克风    → muted，优先级最高，房间内外、按不按键都一样
  //   自由发言·使能 → talk
  //   按键说话·使能 → 闸门打开期间 talk，关闭后 armed
  // 闸门 S.open 按下时置真、释放延迟结束才置假，所以"释放延迟后才变灰"是它的自然结果。
  //
  // 禁用信号有三路：图标静音形态、轨道 want、RTC 上报。
  // 图标形态只在房间外用：房间内说话时图标有音量波形动画，中心命中数会在阈值附近跳动，
  // 导致状态反复切换、圆点红绿闪烁；房间内有 track/RTC 这两个可靠信号。

  function micSignals() {
    const live = liveTracks();
    return {
      iconMuted: !inRoom() && !!(loc.mic && loc.mic.iconMuted),
      tracksMuted: live.length > 0 && !live.some((t) => wants.get(t)),
      rtcMuted: rtcMuted(),
      mode: S.cfg.mode,
      open: S.open,
    };
  }

  function micState(sig) {
    if (sig.iconMuted || sig.tracksMuted || sig.rtcMuted) return 'muted';
    if (sig.mode !== 'ptt') return 'talk';
    return sig.open ? 'talk' : 'armed';
  }

  /* ════════════════════ 界面 ════════════════════ */

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
/* 与 Oopz 头像上的在线点同尺寸（约 5px）、纯色、无描边；光晕只在绿点（正在发送）时由 JS 添加 */
.badge i { position: absolute; left: -2.5px; top: -2.5px; width: 5px; height: 5px; border-radius: 50%;
  background: #8c8c8c; transition: background-color .15s, box-shadow .08s linear; }
.toast { position: absolute; left: 50%; bottom: 48px; transform: translateX(-50%); background: rgba(30,30,30,.96); color: var(--fg1);
  border: 1px solid #333; border-radius: 8px; padding: 8px 14px; font-size: 13px; opacity: 0; transition: opacity .2s; pointer-events: none; }
.toast.show { opacity: 1; }
.light .toast { background: rgba(255,255,255,.98); border-color: #ddd; }
`;

  function statusHtml() {
    const ptt = S.cfg.mode === 'ptt';
    if (S.host) {
      const v = S.hostVersion ? ` v${S.hostVersion}` : '';
      return `<span class="dot" style="background:var(--ok)"></span>本地助手已连接${v}，` +
        (ptt ? `在任何程序中按住&nbsp;<b>${esc(bindingName(S.cfg.binding))}</b>&nbsp;即可说话` : '选择按键说话后，按住快捷键才会发送声音');
    }
    const warn = '<span class="dot" style="background:var(--warn)"></span>';
    if (IS_WS && lna === 'denied') {
      return warn + '浏览器拦截了本页对本机程序的访问，请在网站设置中允许「本设备上的应用」后刷新';
    }
    if (IS_WS && lna === 'prompt') {
      return warn + '如果浏览器询问是否允许访问本设备上的应用，请选择「允许」';
    }
    const dl = `<a href="${HOME_URL}/releases/latest" target="_blank" rel="noopener">下载本地助手</a>`;
    return warn + '未连接本地助手，快捷键只在本页面处于前台时有效。' + dl;
  }

  function buildControls(el) {
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
    return function updatePanel() {
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
      hint.innerHTML = statusHtml();
    };
  }

  function startLearn() {
    S.learning = true;
    pageKey.learnMod = 0;
    if (S.host) send({ t: 'learn' });
    clearTimeout(startLearn.timer);
    startLearn.timer = setTimeout(() => { if (S.learning) cancelLearn(); }, 15000);
    schedulePaint();
  }

  function cancelLearn() {
    S.learning = false;
    if (S.host) send({ t: 'learnCancel' });
    schedulePaint();
  }

  let ui = null;
  // 右键会弹出 Oopz 自己的竖排语音菜单，脚本面板如果还留在原地会和它叠在一起
  let inlineSuspended = false;

  function createUi() {
    const hostEl = document.createElement('oopz-ptt');
    const root = hostEl.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>${CSS}</style>
      <div class="layer">
        <div class="badge"><i></i></div>
        <div class="inline"></div>
        <div class="toast"></div>
      </div>`;
    document.documentElement.appendChild(hostEl);

    const layer = root.querySelector('.layer');
    const badge = root.querySelector('.badge');
    const badgeDot = badge.querySelector('i');
    const inline = root.querySelector('.inline');
    const toastEl = root.querySelector('.toast');

    const updatePanel = buildControls(inline);
    // 面板顶部 = 圆心 - 14，每行高 28，所以行的 top 就是该行中心相对圆心的偏移
    const rows = inline.querySelectorAll('.row');
    const R = LOCATE.panelRows;
    [R.radio, R.hint, R.header, R.keys].forEach((y, i) => { rows[i].style.top = y + 'px'; });

    for (const t of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu', 'keydown', 'keyup']) {
      inline.addEventListener(t, (e) => e.stopPropagation());
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

    // 只摆位置：圆点与面板。位置只由锚点决定，与运行状态无关。
    function layout() {
      if (loc.mic) {
        badge.style.left = (inRoom() ? LOCATE.badge.in : LOCATE.badge.out) + 'px';
        badge.style.top = LOCATE.badge.top + 'px';
      }
      if (loc.voice && !inlineSuspended) {
        const left = loc.voice.cx - 7;
        inline.style.left = left + 'px';
        inline.style.top = (loc.voice.cy - 14) + 'px';
        inline.style.width = Math.max(420, Math.min(600, innerWidth - left - 24)) + 'px';
        inline.style.height = (LOCATE.panelRows.keys + 30) + 'px';
        inline.classList.add('show');
      } else {
        hideInline();
      }
    }

    // 缓存当前状态，供 10Hz 的音量回调判断要不要画光晕
    let currentState = 'armed';

    // 绿点外发光：半径与透明度随实际发送音量变化。只在 talk（正在发送）时出现，
    // 灰点/红点一律清掉，避免把"禁用"误读成"在说话"。
    function applyGlow() {
      if (currentState !== 'talk' || !loc.mic) {
        badgeDot.style.boxShadow = 'none';
        return;
      }
      const l = S.level;
      const radius = 2 + l * 7;
      const spread = 1 + l * 2;
      const alpha = 0.25 + l * 0.55;
      badgeDot.style.boxShadow = `0 0 ${radius.toFixed(1)}px ${spread.toFixed(1)}px rgba(103,221,13,${alpha.toFixed(2)})`;
    }

    // 只刷内容：圆点颜色与面板文字。状态变化走这里，不重复摆位置。
    function paint() {
      const st = micState(micSignals());
      currentState = st;
      badge.classList.toggle('show', !!loc.mic);
      if (loc.mic) {
        badgeDot.style.background = STATE_COLOR[st];
        applyGlow();
      }
      if (inline.classList.contains('show')) updatePanel();
    }

    // 音量每 100ms 更新一次，只改光晕，不触发面板重绘
    function setLevel(level) {
      if (Math.abs(level - S.level) < 0.01) return;
      S.level = level;
      if (currentState === 'talk' && loc.mic) applyGlow();
    }

    function applyAnchors(mic, voice) {
      loc.mic = mic;
      loc.voice = voice;
      const bg = (voice && voice.bg) || (mic && mic.bg);
      if (bg) applyTheme(bg, mic && mic.pill, voice && voice.accent);
      layout();
      paint();
    }

    function hideInline() {
      inline.classList.remove('show');
    }

    let toastTimer = 0;
    function showToast(text) {
      toastEl.textContent = text;
      toastEl.classList.add('show');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2200);
    }

    return {
      paint, layout, applyAnchors, hideInline, showToast, setLevel,
      get mic() { return loc.mic; },
      get voice() { return loc.voice; },
    };
  }

  function toast(text) {
    if (ui) ui.showToast(text);
  }

  // 状态变化高频（按键、轨道、RTC），用 rAF 合并，一帧最多刷一次
  let paintQueued = false;
  function schedulePaint() {
    if (paintQueued || !ui) return;
    paintQueued = true;
    requestAnimationFrame(() => {
      paintQueued = false;
      if (ui) ui.paint();
    });
  }

  /* ════════════════════ 定位巡检 ════════════════════ */

  let scanTimer = 0;
  let lastVoice = null;
  let voiceHits = 0;

  function scan() {
    if (!ui) return;
    let mic = null;
    let voice = null;
    try { mic = findMic(); } catch (e) { }
    try { voice = findVoiceRadio(); } catch (e) { }

    if (voice) {
      const same = lastVoice && Math.abs(voice.cx - lastVoice.cx) <= 4 && Math.abs(voice.cy - lastVoice.cy) <= 4;
      voiceHits = same ? voiceHits + 1 : 1;
      lastVoice = voice;
      // 首次命中先复查一次，排除滚动、动画或相邻图形造成的误判
      if (voiceHits < 2) {
        ui.applyAnchors(mic, null);
        scheduleScan(160);
        return;
      }
    } else {
      voiceHits = 0;
      lastVoice = null;
    }
    ui.applyAnchors(mic, voice);
  }

  function scheduleScan(delay) {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, delay);
  }

  // 定时核对锚点是否还有效。顶栏和设置项都没找到时降低频率。
  let verifyTick = 0;
  function verify() {
    if (!ui || document.hidden) return;
    const v = ui.voice;
    const m = ui.mic;
    if (!m && !v && ++verifyTick % 2 !== 0) return;
    let stale = false;
    let fresh = null;
    try {
      if (v) {
        const p = probe.read(v.cx, v.cy, 1, 1);
        if (!p || !isAccent(p.at(0, 0))) stale = true;
      }
      if (m) {
        // 必须完整重定位：进出房时胶囊整体平移，只测 (left+2, cy) 一个点仍会落在胶囊
        // 底色上，被误判为有效，圆点就滞留在旧位置。
        fresh = findMic();
        if (!fresh) stale = true;
        else if (Math.abs(fresh.cx - m.cx) > 3 || Math.abs(fresh.cy - m.cy) > 3) stale = true;
      } else {
        stale = true;
      }
    } catch (e) { stale = true; }
    if (stale) { scan(); return; }
    // 小幅位移直接更新，不等下一次交互事件；静音切换时 cx/cy 不变但 iconMuted 会变，
    // 必须一并比较，否则红/灰状态不刷新。
    if (fresh && (fresh.cx !== m.cx || fresh.cy !== m.cy || fresh.iconMuted !== m.iconMuted)) ui.applyAnchors(fresh, v);
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

  /* ════════════════════ 启动 ════════════════════ */

  function start() {
    if (ui) return;
    ui = createUi();

    // 扩展和油猴同时安装时只有一份生效，提示用户避免以为装重了会加倍生效
    setTimeout(() => {
      const other = IS_BRIDGE ? window.__oopzPttUser : window.__oopzPttExt;
      if (other) toast('检测到扩展和油猴脚本同时安装，当前只有一份生效，建议移除其中一个');
    }, 1500);

    const onPointerUp = () => { scheduleScan(250); setTimeout(scan, 900); };
    // 右键：Oopz 会弹出自己的语音菜单，先让开面板；左键点回来再恢复
    window.addEventListener('pointerdown', (e) => {
      if (e.button === 2) {
        inlineSuspended = true;
        ui.hideInline();
      } else if (e.button === 0 && inlineSuspended) {
        inlineSuspended = false;
        scheduleScan(200);
      }
    }, true);
    window.addEventListener('pointerup', onPointerUp, true);
    window.addEventListener('keyup', () => scheduleScan(300), true);
    window.addEventListener('wheel', (e) => {
      if (e.composedPath().some((n) => n && n.tagName === 'OOPZ-PTT')) return;
      ui.hideInline();
      scheduleScan(220);
    }, { capture: true, passive: true });
    window.addEventListener('resize', () => { ui.hideInline(); scheduleScan(300); });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) scheduleScan(300); });
    setInterval(verify, 400);

    let fontTries = 0;
    const tryFont = () => loadFont().then((done) => { if (!done && ++fontTries < 20) setTimeout(tryFont, 1500); });
    tryFont();
    scheduleScan(500);
  }

  // 等 Flutter 画出第一帧再挂界面；页面结构变了也在 10 秒后挂上，至少保证设置面板可用
  const bootAt = Date.now();
  function waitForFlutter() {
    if (probe.canvas() || Date.now() - bootAt > 10000) start();
    else setTimeout(waitForFlutter, 500);
  }

  transport.start(
    () => send({ t: 'hello', v: VERSION }),
    hostDown,
    onHostMessage,
  );

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', waitForFlutter, { once: true });
  else waitForFlutter();
})();
