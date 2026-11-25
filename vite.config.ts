/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from "vite";
import pkg from "./package.json" with { type: "json" };

/**
 * Content-Security-Policy is injected only into the production build.
 * GitHub Pages cannot send custom headers, so a <meta> CSP is the best available option.
 * The dev server needs inline scripts / HMR websockets, so it is excluded there.
 */
const PRODUCTION_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self' https://0.peerjs.com wss://0.peerjs.com",
  "media-src 'self' blob: mediastream:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

function productionCsp(): Plugin {
  return {
    name: "psstamigo-production-csp",
    apply: "build",
    transformIndexHtml(html) {
      return html.replace(
        "<!-- CSP -->",
        `<meta http-equiv="Content-Security-Policy" content="${PRODUCTION_CSP}">`,
      );
    },
  };
}

export default defineConfig({
  // GitHub Pages project site: https://<user>.github.io/psstamigo/
  base: "/psstamigo/",
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  plugins: [productionCsp()],
  build: {
    target: "es2022",
    sourcemap: false,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  test: {
    include: ["tests/unit/**/*.test.ts"],
    environment: "node",
  },
});
