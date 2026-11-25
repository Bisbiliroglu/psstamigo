import { describe, expect, it } from "vitest";
import { otherProtocolVersion, parseMessage, sanitizeDisplayName } from "../../src/session/protocol";
import { LIMITS, MAX_PARTICIPANTS } from "../../src/core/config";
import { BoundedSet, memberSnapshot, newMessageId, newSessionId, sameMembers } from "../../src/session/admission";

const SID = "a".repeat(32);
const AID = "b".repeat(32);
const U1 = "psst-aaaa-aaaa-aaaa";
const U2 = "psst-bbbb-bbbb-bbbb";
const U3 = "psst-cccc-cccc-cccc";
/** Distinct valid UIDs for size-limit tests. */
const fakeUid = (i: number): string => `psst-${"23456789ab"[i % 10]!.repeat(4)}-${"cdefghjkmn"[Math.floor(i / 10)]!.repeat(4)}-aaaa`;

describe("protocol v2 parseMessage", () => {
  it("accepts well-formed messages", () => {
    expect(parseMessage({ t: "join-request", v: 2, name: "Ali" })).toEqual({ t: "join-request", v: 2, name: "Ali" });
    expect(parseMessage({ t: "join-reject", v: 2, reason: "full" })).toEqual({ t: "join-reject", v: 2, reason: "full" });
    expect(parseMessage({ t: "chat", v: 2, sid: SID, id: "1".repeat(16), text: "selam\nnasılsın" })).toMatchObject({
      text: "selam\nnasılsın",
    });
    expect(parseMessage({ t: "leave", v: 2, sid: SID })).toEqual({ t: "leave", v: 2, sid: SID });
    expect(
      parseMessage({ t: "admit-propose", v: 2, sid: SID, aid: AID, candidate: U3, name: "C", members: [U1, U2] }),
    ).toMatchObject({ candidate: U3, members: [U1, U2] });
    expect(
      parseMessage({ t: "join-accept", v: 2, sid: SID, aid: AID, name: "B", members: [{ uid: U1, name: "A" }] }),
    ).toMatchObject({ members: [{ uid: U1, name: "A" }] });
    expect(parseMessage({ t: "admit-vote", v: 2, sid: SID, aid: AID, vote: "conflict" })).toMatchObject({ vote: "conflict" });
  });

  it.each([
    null,
    undefined,
    "join-request",
    42,
    [],
    { t: "join-request", v: 1, name: "x" },
    { t: "join-request", v: 3, name: "x" },
    { t: "unknown", v: 2 },
    { t: "chat", v: 2, sid: SID, id: "1".repeat(16), text: "" },
    { t: "chat", v: 2, sid: SID, id: "1".repeat(16), text: "hi", from: U1 },
    { t: "chat", v: 2, sid: "short", id: "1".repeat(16), text: "hi" },
    { t: "chat", v: 2, sid: SID, id: "XYZ", text: "hi" },
    { t: "chat", v: 2, sid: SID, id: "1".repeat(16) },
    { t: "join-reject", v: 2, reason: "hacked" },
    { t: "join-request", v: 2, name: "x".repeat(LIMITS.displayNameChars + 1) },
    { t: "chat", v: 2, sid: SID, id: "1".repeat(16), text: "x".repeat(LIMITS.chatChars + 1) },
    { t: "admit-vote", v: 2, sid: SID, aid: AID, vote: "maybe" },
    { t: "admit-propose", v: 2, sid: SID, aid: AID, candidate: U3, name: "C", members: [U1] },
    { t: "admit-propose", v: 2, sid: SID, aid: AID, candidate: U1, name: "C", members: [U1, U2] },
    { t: "admit-propose", v: 2, sid: SID, aid: AID, candidate: U3, name: "C", members: [U1, U1] },
    { t: "admit-propose", v: 2, sid: SID, aid: AID, candidate: U3, name: "C", members: [U1, "bad"] },
    {
      t: "admit-propose",
      v: 2,
      sid: SID,
      aid: AID,
      candidate: U3,
      name: "C",
      members: Array.from({ length: MAX_PARTICIPANTS }, (_, i) => fakeUid(i)),
    },
    { t: "join-accept", v: 2, sid: SID, aid: AID, name: "B", members: [{ uid: U1 }] },
    { t: "join-accept", v: 2, sid: SID, aid: AID, name: "B", members: [{ uid: U1, name: "A", ip: "x" }] },
    {
      t: "join-accept",
      v: 2,
      sid: SID,
      aid: AID,
      name: "B",
      members: Array.from({ length: MAX_PARTICIPANTS - 1 }, (_, i) => ({ uid: fakeUid(i), name: "x" })),
    },
    { t: "__proto__", v: 2 },
    { t: "toString", v: 2 },
  ])("rejects malformed input %#", (raw) => {
    expect(parseMessage(raw)).toBeNull();
  });

  it("rejects oversized payloads before inspecting them", () => {
    expect(parseMessage({ t: "chat", v: 2, sid: SID, id: "1".repeat(16), text: "a", pad: "x".repeat(10_000) })).toBeNull();
  });

  it("rejects non-plain objects", () => {
    class Evil {
      t = "leave";
      v = 2;
      sid = SID;
    }
    expect(parseMessage(new Evil())).toBeNull();
    expect(parseMessage(Object.create({ t: "leave", v: 2, sid: SID }))).toBeNull();
  });

  it("keeps HTML as inert text (rendering uses textContent)", () => {
    const msg = parseMessage({ t: "chat", v: 2, sid: SID, id: "1".repeat(16), text: "<img src=x onerror=alert(1)>" });
    expect(msg).toMatchObject({ text: "<img src=x onerror=alert(1)>" });
  });

  it("strips control and bidi-override characters from names", () => {
    expect(sanitizeDisplayName("A‮li\u0000")).toBe("Ali");
    expect(sanitizeDisplayName("   ")).toBe("");
  });

  it("detects other protocol versions for an explicit rejection", () => {
    expect(otherProtocolVersion({ t: "join-request", v: 1, name: "x" })).toBe(1);
    expect(otherProtocolVersion({ t: "join-request", v: 2, name: "x" })).toBeNull();
    expect(otherProtocolVersion("v1")).toBeNull();
    expect(otherProtocolVersion({ v: 1e9 })).toBeNull();
  });
});

describe("admission helpers", () => {
  it("generates CSPRNG ids of the right size", () => {
    expect(newSessionId()).toMatch(/^[0-9a-f]{32}$/);
    expect(newMessageId()).toMatch(/^[0-9a-f]{16}$/);
    expect(new Set(Array.from({ length: 500 }, () => newSessionId())).size).toBe(500);
  });

  it("compares member sets independent of order and duplicates", () => {
    expect(memberSnapshot([U2, U1, U2])).toEqual([U1, U2]);
    expect(sameMembers([U1, U2], [U2, U1])).toBe(true);
    expect(sameMembers([U1, U2], [U1, U2, U3])).toBe(false);
  });

  it("bounded set evicts the oldest entries", () => {
    const s = new BoundedSet<string>(2);
    expect(s.add("a")).toBe(true);
    expect(s.add("a")).toBe(false);
    s.add("b");
    s.add("c");
    expect(s.has("a")).toBe(false);
    expect(s.has("c")).toBe(true);
    expect(s.size).toBe(2);
  });
});
