export default defineBackground(() => {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== "gptd:get-tab-audio-stream-id") {
      return false;
    }

    const tabId = sender.tab?.id;
    if (!tabId) {
      sendResponse({ ok: false, error: "No active tab was available for tab audio capture." });
      return false;
    }

    chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (streamId) => {
      const error = chrome.runtime.lastError?.message;
      if (error || !streamId) {
        sendResponse({ ok: false, error: error || "Unable to create tab audio stream." });
        return;
      }

      sendResponse({ ok: true, streamId });
    });

    return true;
  });
});
