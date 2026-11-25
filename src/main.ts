import "./ui/styles.css";
import { App } from "./app/App";
import { SingleTab } from "./app/SingleTab";

/**
 * Clickjacking protection. GitHub Pages cannot send `X-Frame-Options` or a CSP
 * `frame-ancestors` header, and `frame-ancestors` is ignored in a <meta> CSP.
 * An embedding page could grant microphone access to an iframe, so the app
 * refuses to start when it is not the top-level document.
 */
function isFramed(): boolean {
  try {
    return window.self !== window.top;
  } catch {
    return true; // cross-origin access error means we are framed
  }
}

function showMainNotice(text: string): void {
  const main = document.querySelector("main");
  const notice = document.createElement("p");
  notice.className = "notice error";
  notice.setAttribute("role", "alert");
  notice.textContent = text;
  main?.replaceChildren(notice);
}

if (isFramed()) {
  showMainNotice("PsstAmigo güvenlik nedeniyle başka bir sayfanın içinde çalıştırılamaz. Lütfen doğrudan açın.");
} else {
  // D-035: one active tab per browser profile. The app (UID, signaling, audio) starts only once this
  // tab holds the lock, so a second tab never creates a hidden extra participant.
  let app: App | null = null;
  const guard = document.getElementById("tab-guard");
  const guardButton = document.getElementById("tab-guard-continue");
  const tab = new SingleTab({
    acquired: () => {
      if (guard) guard.hidden = true;
      if (app) return;
      app = new App();
      app.start();
    },
    busy: (takeOver) => {
      if (!guard || !guardButton) return takeOver();
      guard.hidden = false;
      guardButton.addEventListener("click", () => {
        guardButton.setAttribute("disabled", "");
        takeOver();
      }, { once: true });
    },
    replaced: () => {
      app?.shutdown(); // leaves the call (others are told), stops audio, destroys the Peer
      app = null;
      showMainNotice("PsstAmigo başka bir sekmede açıldı; bu sekme kapatıldı. Bu sekmeyi kapatabilirsin.");
    },
  });
  window.addEventListener("pagehide", () => tab.stop());
  tab.start();
}
