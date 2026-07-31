let socket = null;
let reconnectTimer = null;

const attachedTabs = new Set();

function tabInfo(tab) {
  return {
    id: tab.id,
    url: tab.url ?? '',
    title: tab.title ?? '',
    active: tab.active ?? false,
    windowId: tab.windowId,
  };
}

const handlers = {
  'tabs.query': async () => (await chrome.tabs.query({})).map(tabInfo),

  'tabs.create': async ({ url }) => tabInfo(await chrome.tabs.create({ url })),

  'debugger.attach': async ({ tabId }) => {
    if (!attachedTabs.has(tabId)) {
      await chrome.debugger.attach({ tabId }, '1.3');
      attachedTabs.add(tabId);
    }
    return { attached: true };
  },

  'debugger.detach': async ({ tabId }) => {
    if (attachedTabs.has(tabId)) {
      attachedTabs.delete(tabId);
      await chrome.debugger.detach({ tabId });
    }
    return { detached: true };
  },

  'debugger.sendCommand': async ({ tabId, sessionId, method, params }) => {
    const target = sessionId ? { tabId, sessionId } : { tabId };
    return (await chrome.debugger.sendCommand(target, method, params)) ?? {};
  },
};

function send(message) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

async function handleCall({ id, method, params }) {
  const handler = handlers[method];
  if (!handler) {
    send({ id, error: `Unknown method: ${method}` });
    return;
  }

  try {
    send({ id, result: await handler(params ?? {}) });
  } catch (err) {
    send({ id, error: err?.message ?? String(err) });
  }
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  send({
    event: 'debugger.event',
    tabId: source.tabId,
    sessionId: source.sessionId,
    method,
    params,
  });
});

chrome.debugger.onDetach.addListener((source) => {
  attachedTabs.delete(source.tabId);
  send({ event: 'debugger.detached', tabId: source.tabId });
});

const DEFAULT_BRIDGE_URL = 'ws://127.0.0.1:9333';

async function connect() {
  const { bridgeUrl } = await chrome.storage.local.get('bridgeUrl');

  socket = new WebSocket(bridgeUrl || DEFAULT_BRIDGE_URL);

  socket.onmessage = (event) => handleCall(JSON.parse(event.data));

  socket.onclose = () => {
    socket = null;
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, 3000);
  };

  socket.onerror = () => socket?.close();
}

chrome.storage.onChanged.addListener((changes) => {
  if (changes.bridgeUrl) {
    socket?.close();
    connect();
  }
});

chrome.alarms.create('reconnect', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => {
  if (!socket || socket.readyState === WebSocket.CLOSED) connect();
});

chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
connect();
