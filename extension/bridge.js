// 在页面脚本（MAIN world）和扩展后台之间转发消息
(() => {
  const TAG = '__oopzPtt';
  let port = null;

  const toPage = (m) => window.postMessage({ [TAG]: 'in', m }, location.origin);

  function connect() {
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
      toPage({ t: '__down' });
      setTimeout(connect, 1000);
    });
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data[TAG] !== 'out' || !port) return;
    try { port.postMessage(e.data.m); } catch (err) { }
  });

  connect();
})();
