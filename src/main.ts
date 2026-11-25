import "./ui/styles.css";
import { App } from "./app/App";

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

if (isFramed()) {
  const main = document.querySelector("main");
  const notice = document.createElement("p");
  notice.className = "notice error";
  notice.setAttribute("role", "alert");
  notice.textContent = "PsstAmigo güvenlik nedeniyle başka bir sayfanın içinde çalıştırılamaz. Lütfen doğrudan açın.";
  main?.replaceChildren(notice);
} else {
  const app = new App();
  app.start();
}
