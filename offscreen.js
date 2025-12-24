async function copyTextToClipboard(text) {
  const value = String(text ?? "");
  if (!value) return;

  try {
    await navigator.clipboard.writeText(value);
    return;
  } catch {
    // fallback below
  }

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.top = "-1000px";
  textarea.style.left = "-1000px";
  document.body.appendChild(textarea);
  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);

  const ok = document.execCommand("copy");
  textarea.remove();
  if (!ok) throw new Error("document.execCommand(copy) failed");
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.__zteSmsNotifierTarget !== "offscreen") return;

  if (message?.type === "offscreenCopy") {
    (async () => {
      try {
        await copyTextToClipboard(message.text);
        sendResponse({ success: true });
      } catch (e) {
        sendResponse({ success: false, message: e?.message ?? String(e) });
      }
    })();
    return true;
  }
});

