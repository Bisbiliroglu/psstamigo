import { describe, expect, it } from "vitest";
import { generateUid, isValidUid, normalizeUid, UID_ALPHABET } from "../../src/core/uid";
import { RateLimiter } from "../../src/core/rateLimiter";
import { ActivityDetector, rmsToLevel } from "../../src/audio/levels";
import { ChatLog } from "../../src/messaging/ChatLog";
import { LIMITS } from "../../src/core/config";

describe("uid", () => {
  it("generates valid, unique UIDs", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      const uid = generateUid();
      expect(isValidUid(uid)).toBe(true);
      seen.add(uid);
    }
    expect(seen.size).toBe(2000);
  });

  it("uses only the unambiguous alphabet", () => {
    expect(UID_ALPHABET).not.toMatch(/[01ilo]/);
    const body = generateUid().slice("psst-".length).replace(/-/g, "");
    for (const ch of body) expect(UID_ALPHABET).toContain(ch);
  });

  it("rejects bias-prone bytes via rejection sampling", () => {
    // Feed 255 (>= limit) first; it must be skipped, then 0 -> first symbol.
    const queue = [255, 0];
    const uid = generateUid((b) => {
      b[0] = queue.length > 0 ? (queue.shift() as number) : 0;
    });
    expect(uid.startsWith(`psst-${UID_ALPHABET[0]}`)).toBe(true);
  });

  it("validates and normalizes input", () => {
    expect(normalizeUid("  PSST-ABCD-EFGH-JKMN ")).toBe("psst-abcd-efgh-jkmn");
    expect(isValidUid("psst-abcd-efgh-jkmn")).toBe(true);
    expect(isValidUid("psst-abc-efgh-jkmn")).toBe(false);
    expect(isValidUid("psst-abcd-efgh-jkm0")).toBe(false);
    expect(isValidUid("<script>")).toBe(false);
    expect(isValidUid(42)).toBe(false);
  });
});

describe("RateLimiter", () => {
  it("allows up to N events per window", () => {
    let t = 0;
    const rl = new RateLimiter(3, 1000, () => t);
    expect([rl.tryConsume(), rl.tryConsume(), rl.tryConsume(), rl.tryConsume()]).toEqual([true, true, true, false]);
    t = 1001;
    expect(rl.tryConsume()).toBe(true);
  });
});

describe("audio levels", () => {
  it("maps silence to 0 and full scale to 1", () => {
    expect(rmsToLevel(new Float32Array(128))).toBe(0);
    expect(rmsToLevel(new Float32Array(128).fill(1))).toBe(1);
    const mid = rmsToLevel(new Float32Array(128).fill(0.03));
    expect(mid).toBeGreaterThan(0.3);
    expect(mid).toBeLessThan(0.9);
  });

  it("applies hysteresis to the speaking state", () => {
    const d = new ActivityDetector();
    let now = 0;
    let out = d.update(0, now);
    expect(out.speaking).toBe(false);
    for (let i = 0; i < 5; i++) out = d.update(0.9, (now += 66));
    expect(out.speaking).toBe(true);
    out = d.update(0, (now += 66)); // short dip: held
    expect(out.speaking).toBe(true);
    for (let i = 0; i < 20; i++) out = d.update(0, (now += 66));
    expect(out.speaking).toBe(false);
  });
});

describe("ChatLog", () => {
  it("caps history and clears", () => {
    const log = new ChatLog(() => 1);
    for (let i = 0; i < LIMITS.chatHistory + 10; i++) log.add(true, "me", `m${i}`);
    expect(log.list()).toHaveLength(LIMITS.chatHistory);
    expect(log.list()[0]?.text).toBe("m10");
    log.clear();
    expect(log.list()).toHaveLength(0);
  });
});
