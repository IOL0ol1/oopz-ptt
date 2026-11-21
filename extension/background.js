// 扩展后台：替页面连接本地助手。
// 页面直接连 127.0.0.1 会触发浏览器的「访问本地网络」权限提示，扩展后台不会。
const HOST_URL = 'ws://127.0.0.1:29271/';

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'oopz-ptt') return;

  let ws = null;
  let alive = true;
  let retryTimer = 0;
  let pingTimer = 0;

  const post = (m) => {
    try { port.postMessage(m); } catch (e) { }
  };

  function open() {
    if (!alive) return;
    try {
      ws = new WebSocket(HOST_URL);
    } catch (e) {
      retry();
      return;
    }
    ws.onopen = () => {
      post({ t: '__up' });
      // 定期发消息，避免扩展后台因空闲被浏览器回收
      pingTimer = setInterval(() => {
        if (ws && ws.readyState === 1) ws.send('{"t":"ping"}');
      }, 20000);
    };
    ws.onmessage = (e) => {
      try { post(JSON.parse(e.data)); } catch (err) { }
    };
    ws.onclose = () => {
      clearInterval(pingTimer);
      ws = null;
      if (!alive) return;
      post({ t: '__down' });
      retry();
    };
    ws.onerror = () => { };
  }

  function retry() {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(open, 2000);
  }

  port.onMessage.addListener((m) => {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(m));
  });

  port.onDisconnect.addListener(() => {
    alive = false;
    clearTimeout(retryTimer);
    clearInterval(pingTimer);
    if (ws) ws.close();
  });

  open();
});
