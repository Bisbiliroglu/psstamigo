import { describe, expect, it } from "vitest";
import { parseMessage, sanitizeDisplayName } from "../../src/session/protocol";
import { LIMITS } from "../../src/core/config";

describe("protocol.parseMessage", () => {
  it("accepts well-formed messages", () => {
    expect(parseMessage({ t: "join-request", v: 1, name: "Ali" })).toEqual({ t: "join-request", v: 1, name: "Ali" });
    expect(parseMessage({ t: "join-reject", v: 1, reason: "busy" })).toEqual({ t: "join-reject", v: 1, reason: "busy" });
    expect(parseMessage({ t: "chat", v: 1, text: "selam\nnasılsın" })).toEqual({ t: "chat", v: 1, text: "selam\nnasılsın" });
    expect(parseMessage({ t: "leave", v: 1 })).toEqual({ t: "leave", v: 1 });
  });

  it.each([
    null,
    undefined,
    "join-request",
    42,
    [],
    { t: "join-request", v: 2, name: "x" },
    { t: "unknown", v: 1 },
    { t: "chat", v: 1, text: "" },
    { t: "chat", v: 1, text: 123 },
    { t: "chat", v: 1, text: "hi", extra: true },
    { t: "join-reject", v: 1, reason: "hacked" },
    { t: "join-request", v: 1, name: "x".repeat(LIMITS.displayNameChars + 1) },
    { t: "chat", v: 1, text: "x".repeat(LIMITS.chatChars + 1) },
    { t: "__proto__", v: 1 },
    { t: "toString", v: 1 },
  ])("rejects malformed input %#", (raw) => {
    expect(parseMessage(raw)).toBeNull();
  });

  it("rejects oversized payloads before inspecting them", () => {
    expect(parseMessage({ t: "chat", v: 1, text: "a", pad: "x".repeat(10_000) })).toBeNull();
  });

  it("rejects non-plain objects", () => {
    class Evil {
      t = "leave";
      v = 1;
    }
    expect(parseMessage(new Evil())).toBeNull();
    expect(parseMessage(Object.create({ t: "leave", v: 1 }))).toBeNull();
  });

  it("keeps HTML as inert text (rendering uses textContent)", () => {
    const msg = parseMessage({ t: "chat", v: 1, text: "<img src=x onerror=alert(1)>" });
    expect(msg).toEqual({ t: "chat", v: 1, text: "<img src=x onerror=alert(1)>" });
  });

  it("strips control and bidi-override characters from names", () => {
    expect(sanitizeDisplayName("A‮li\u0000")).toBe("Ali");
    expect(sanitizeDisplayName("   ")).toBe("");
  });
});
