// 在页面脚本（MAIN world）和扩展后台之间转发消息。
// 惰性连接：只有页面脚本明确要求（want）时才连后台。这样当页面里生效的是油猴脚本时，
// 这里不会留下一条没人接收的助手连接。
(() => {
  const TAG = '__oopzPtt';
  let port = null;
  let released = false;

  const toPage = (m) => window.postMessage({ [TAG]: 'in', m }, location.origin);

  function connect() {
    if (released || port) return;
    try {
      port = chrome.runtime.connect({ name: 'oopz-ptt' });
    } catch (e) {
      // 扩展被重新加载后，旧页面里的脚本会失效，等刷新页面即可
      port = null;
      toPage({ t: '__down' });
      return;
    }
    port.onMessage.addListener(toPage);
    port.onDisconnect.addListener(() => {
      port = null;
      if (released) return;
      toPage({ t: '__down' });
      setTimeout(connect, 1000);
    });
  }

  function release() {
    released = true;
    if (port) {
      const p = port;
      port = null;
      try { p.disconnect(); } catch (e) { }
    }
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data) return;
    const tag = e.data[TAG];
    if (tag === 'want') { connect(); return; }
    if (tag === 'release') { release(); return; }
    if (tag !== 'out' || !port) return;
    try { port.postMessage(e.data.m); } catch (err) { }
  });
})();
