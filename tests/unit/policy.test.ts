/**
 * Static privacy policy checks over application source (PRIV-008, PRIV-009, PRIV-010).
 * Third-party library code (PeerJS / webrtc-adapter) is not scanned here; see PRIVACY_SECURITY.md.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ICE_SERVERS } from "../../src/core/config";

const ROOT = new URL("../../", import.meta.url).pathname;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const sources = walk(join(ROOT, "src"))
  .filter((p) => /\.(ts|css)$/.test(p))
  .map((p) => ({ path: p.slice(ROOT.length), code: readFileSync(p, "utf8") }));

const FORBIDDEN: Array<[RegExp, string]> = [
  [/getDisplayMedia/, "screen capture (PRIV-008)"],
  [/video\s*:\s*true/, "video capture (PRIV-008)"],
  [/MediaRecorder/, "recording (PRIV-009)"],
  [/indexedDB|localStorage|sessionStorage|document\.cookie/, "persistent storage (spike: none)"],
  [/\.innerHTML|outerHTML|insertAdjacentHTML|document\.write/, "HTML injection risk"],
  [/\beval\(|new Function\(/, "dynamic code"],
  [/https?:\/\/(?!0\.peerjs\.com)[a-z0-9.-]+\.[a-z]{2,}/i, "external URL (PRIV-010)"],
  [/sendBeacon|navigator\.geolocation/, "tracking / extra data"],
  [/\.clone\(\)/, "cloned media tracks (PRIV-002: every capture must be stoppable)"],
  [/turns?:/i, "TURN servers (D-003: STUN only)"],
];

describe("source policy", () => {
  it("scans a non-trivial number of files", () => {
    expect(sources.length).toBeGreaterThan(10);
  });

  for (const [pattern, why] of FORBIDDEN) {
    it(`does not use ${why}`, () => {
      const hits = sources.filter((s) => pattern.test(s.code)).map((s) => s.path);
      expect(hits).toEqual([]);
    });
  }

  it("only PeerJsSignaling imports peerjs", () => {
    const importers = sources.filter((s) => /from\s+["']peerjs["']/.test(s.code)).map((s) => s.path);
    expect(importers).toEqual(["src/signaling/PeerJsSignaling.ts"]);
  });

  it("ICE configuration is STUN only and replaces PeerJS defaults (D-003)", () => {
    const urls = ICE_SERVERS.flatMap((s) => (Array.isArray(s.urls) ? s.urls : [s.urls]));
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((u) => u.startsWith("stun:"))).toBe(true);
    const signaling = sources.find((s) => s.path === "src/signaling/PeerJsSignaling.ts")?.code ?? "";
    // Every Peer is created with the explicit STUN-only config (which replaces PeerJS's default TURN).
    expect(signaling).toMatch(/createPeerInstance\(uid, \{ config: \{ iceServers: ICE_SERVERS \}/);
    expect(signaling).toMatch(/const defaultFactory: PeerFactory = \(id, options\) => new Peer\(id, options\);/);
    expect(signaling.match(/new Peer\(/g)).toHaveLength(1);
  });

  it("index.html has noindex and no external resources", () => {
    const html = readFileSync(join(ROOT, "index.html"), "utf8");
    expect(html).toContain('<meta name="robots" content="noindex, nofollow" />');
    expect(html).not.toMatch(/<(script|link)[^>]+(src|href)="https?:/);
  });
});
