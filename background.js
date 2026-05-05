const qwenControllers = new Map();

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;
  await chrome.tabs.sendMessage(tab.id, { type: "RTH_TOGGLE_PANEL" }).catch(() => {});
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "RTH_QWEN_ABORT") {
    const controller = qwenControllers.get(message.requestId);
    if (controller) {
      controller.abort();
      qwenControllers.delete(message.requestId);
    }
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type !== "RTH_QWEN_EXTRACT") return false;

  const controller = new AbortController();
  qwenControllers.set(message.requestId, controller);

  fetch(message.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(message.body),
    signal: controller.signal
  })
    .then(async (response) => {
      const text = await response.text();
      if (!response.ok) {
        throw new Error(`Qwen request failed: HTTP ${response.status} ${text.slice(0, 180)}`);
      }
      return text ? JSON.parse(text) : {};
    })
    .then((payload) => sendResponse({ ok: true, payload }))
    .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }))
    .finally(() => qwenControllers.delete(message.requestId));

  return true;
});
