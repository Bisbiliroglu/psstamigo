/**
 * 1:1 session regression (protocol v2) on the in-memory mesh network.
 * Group-specific behavior is in group.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LIMITS, MAX_PARTICIPANTS, TIMEOUTS } from "../../src/core/config";
import { FakeNetwork, formGroup, incomingOf, memberIds, uidOf, type NetDataLink } from "./fakeNetwork";

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

let net: FakeNetwork;
beforeEach(() => {
  vi.useFakeTimers();
  net = new FakeNetwork();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

function pair() {
  const a = net.add(uidOf(0), "Ayla");
  const b = net.add(uidOf(1), "Bora");
  return { a, b };
}

describe("1:1 request and authorization (PRIV-011)", () => {
  it("shows the request without any media, audio or member info before acceptance", () => {
    const { a, b } = pair();
    b.session.requestJoin(a.uid);
    net.settle();
    expect(incomingOf(a)).toMatchObject({ peerId: b.uid, name: "Bora", stage: "voting", myVote: "pending" });
    expect(a.session.snapshot().phase).toBe("idle");
    expect(b.session.snapshot()).toMatchObject({ phase: "requesting", joinStage: "approval" });
    expect(net.openMediaBetween(a.uid, b.uid)).toHaveLength(0);
    expect(net.openMediaBetween(b.uid, a.uid)).toHaveLength(0);
    expect(a.gum).not.toHaveBeenCalled();
    expect(b.gum).not.toHaveBeenCalled();
    expect(a.senders.size + b.senders.size).toBe(0);
  });

  it("accept forms a session with mic and speaker off on both sides", () => {
    const { a, b } = pair();
    formGroup(net, [a, b]);
    for (const n of [a, b]) {
      expect(n.session.snapshot().phase).toBe("active");
      expect(n.session.snapshot().capacity).toEqual({ count: 2, max: MAX_PARTICIPANTS });
      expect(n.session.snapshot().lowBandwidth).toBe(false);
      expect(n.mic.snapshot().state).toBe("off");
      expect(n.speaker.isEnabled()).toBe(false);
      expect(n.gum).not.toHaveBeenCalled();
      expect(n.players.filter((p) => p.playing)).toHaveLength(0);
      // committed: sender registered but carries nothing while mic is off
      expect([...n.senders.values()].every((s) => s.track === null)).toBe(true);
    }
    expect(memberIds(a)).toEqual([b.uid]);
    expect(memberIds(b)).toEqual([a.uid]);
    expect(net.openLinksBetween(a.uid, b.uid)).toHaveLength(1);
    expect(net.openMediaBetween(a.uid, b.uid)).toHaveLength(1);
  });

  it("reject returns both sides to idle without media", () => {
    const { a, b } = pair();
    b.session.requestJoin(a.uid);
    net.settle();
    a.session.rejectRequest(incomingOf(a)!.id);
    net.settle();
    expect(b.session.snapshot().phase).toBe("idle");
    expect(b.session.snapshot().notice?.text).toMatch(/reddedildi/);
    expect(a.session.snapshot().phase).toBe("idle");
    expect(net.mediaLinks).toHaveLength(0);
  });

  it("validates the target UID and prevents self-connection", () => {
    const { a } = pair();
    a.session.requestJoin("garbage");
    expect(a.session.snapshot().notice?.kind).toBe("error");
    a.session.requestJoin(a.uid);
    expect(a.session.snapshot().notice?.text).toMatch(/Kendinize/);
    expect(net.dataLinks).toHaveLength(0);
  });

  it("fails fast for an unavailable UID", () => {
    const { a } = pair();
    a.session.requestJoin(uidOf(9));
    net.settle();
    expect(a.session.snapshot().phase).toBe("idle");
    expect(a.session.snapshot().notice?.text).toMatch(/çevrimiçi değil/);
  });

  it("times out if the request is not answered", () => {
    const { a, b } = pair();
    b.session.requestJoin(a.uid);
    net.settle();
    vi.advanceTimersByTime(TIMEOUTS.admissionVoteMs + 1);
    net.settle();
    expect(b.session.snapshot().phase).toBe("idle");
    expect(a.session.snapshot().incoming).toHaveLength(0);
  });

  it("cancel withdraws the request on the other side", () => {
    const { a, b } = pair();
    b.session.requestJoin(a.uid);
    net.settle();
    b.session.cancelRequest();
    net.settle();
    expect(a.session.snapshot().incoming).toHaveLength(0);
    expect(b.session.snapshot().phase).toBe("idle");
  });

  it("a second request while one is pending is rejected as busy", () => {
    const { a, b } = pair();
    const c = net.add(uidOf(2), "Cem");
    b.session.requestJoin(a.uid);
    net.settle();
    c.session.requestJoin(a.uid);
    net.settle();
    expect(c.session.snapshot().phase).toBe("idle");
    expect(c.session.snapshot().notice?.text).toMatch(/başka bir/);
    expect(incomingOf(a)?.peerId).toBe(b.uid);
  });

  it("a user already in a session cannot start another one (no merging, GR-010)", () => {
    const { a, b } = pair();
    const c = net.add(uidOf(2), "Cem");
    const d = net.add(uidOf(3), "Deniz");
    formGroup(net, [a, b]);
    formGroup(net, [c, d]);
    a.session.requestJoin(c.uid);
    expect(a.session.snapshot().notice?.text).toMatch(/önce ayrılın/);
    expect(memberIds(a)).toEqual([b.uid]);
  });
});

describe("incoming link hygiene", () => {
  it("closes links whose first message is not a join request or mesh hello", () => {
    const { a } = pair();
    const stranger = net.add(uidOf(5), "X");
    const link = net.connect(stranger.uid, a.uid) as NetDataLink;
    net.settle();
    link.send({ t: "chat", v: 2, sid: "0".repeat(32), id: "0".repeat(16), text: "let me in" });
    net.settle();
    expect(link.closed).toBe(true);
    expect(a.session.snapshot().chat).toHaveLength(0);
  });

  it("answers an older protocol version with a rejection in that version", () => {
    const { a } = pair();
    const old = net.add(uidOf(5), "Old");
    const link = net.connect(old.uid, a.uid) as NetDataLink;
    const received: unknown[] = [];
    link.onData((d) => received.push(d));
    net.settle();
    link.send({ t: "join-request", v: 1, name: "old client" });
    net.settle();
    expect(received).toContainEqual({ t: "join-reject", v: 1, reason: "invalid" });
    expect(a.session.snapshot().incoming).toHaveLength(0);
  });

  it("closes handshakes that never identify themselves", () => {
    const { a } = pair();
    const s = net.add(uidOf(5), "S");
    const link = net.connect(s.uid, a.uid) as NetDataLink;
    net.settle();
    vi.advanceTimersByTime(TIMEOUTS.dataOpenMs + 1);
    net.settle();
    expect(link.closed).toBe(true);
  });

  it("bounds unidentified handshakes", () => {
    const { a } = pair();
    const links: NetDataLink[] = [];
    for (let i = 0; i < LIMITS.unauthenticatedLinks + 1; i++) {
      const uid = `psst-cccc-cccc-c${"23456789"[i]}cc`;
      net.add(uid, "S");
      links.push(net.connect(uid, a.uid) as NetDataLink);
    }
    net.settle();
    expect(links.filter((l) => l.closed)).toHaveLength(1);
  });

  it("closes media offers when no admission is in progress", () => {
    const { a } = pair();
    const s = net.add(uidOf(5), "S");
    net.call(s.uid, a.uid, { getAudioTracks: () => [], getTracks: () => [] } as unknown as MediaStream);
    net.settle();
    expect(net.mediaLinks.some((l) => l.answered)).toBe(false);
    expect(net.openMediaBetween(a.uid, s.uid)).toHaveLength(0);
  });
});

describe("1:1 media lifecycle", () => {
  it("mic on sends the single live capture; mic off detaches and stops it (PRIV-002)", async () => {
    const { a, b } = pair();
    formGroup(net, [a, b]);
    await a.mic.enable();
    await flush();
    const track = a.capturedTracks[0]!;
    expect(a.senders.get(b.uid)?.track).toBe(track);
    a.mic.disable();
    await flush();
    expect(a.senders.get(b.uid)?.track).toBeNull();
    expect(track.readyState).toBe("ended");
  });

  it("speaker plays only after explicit enable", () => {
    const { a, b } = pair();
    formGroup(net, [a, b]);
    expect(a.players.filter((p) => p.playing)).toHaveLength(0);
    a.speaker.enable();
    expect(a.players.filter((p) => p.playing)).toHaveLength(1);
    a.speaker.disable();
    expect(a.players.filter((p) => p.playing)).toHaveLength(0);
  });

  it("shows an interruption instead of 'connected' while ICE is disconnected; failure keeps chat", () => {
    const { a, b } = pair();
    formGroup(net, [a, b]);
    const pc = net.openMediaBetween(a.uid, b.uid)[0]!.pc!;
    pc.setIce("disconnected");
    expect(a.session.snapshot().participants[0]?.media).toBe("interrupted");
    pc.setIce("connected");
    expect(a.session.snapshot().participants[0]?.media).toBe("connected");
    pc.setIce("failed");
    net.settle();
    // PA-011: a media failure with a healthy data link starts bounded recovery (not a departure).
    expect(a.session.snapshot().participants[0]?.media).toBe("recovering");
    expect(a.session.snapshot().phase).toBe("active"); // media failure is not a departure
    expect(a.session.sendChat("hala burada")).toBe(true);
    net.settle();
    expect(b.session.snapshot().chat.some((c) => c.text === "hala burada")).toBe(true);
  });

  it("leave tears everything down, resets audio and keeps the UID", async () => {
    const { a, b } = pair();
    formGroup(net, [a, b]);
    await a.mic.enable();
    a.speaker.enable();
    a.session.sendChat("hi");
    net.settle();
    a.session.leave();
    net.settle();
    for (const n of [a, b]) {
      expect(n.session.snapshot().phase).toBe("idle");
      expect(n.session.snapshot().chat).toHaveLength(0);
      expect(n.sessionEnded).toBe(1);
    }
    expect(a.capturedTracks.every((t) => t.readyState === "ended")).toBe(true);
    expect(a.players.every((p) => !p.playing)).toBe(true);
    expect(net.dataLinks.every((l) => l.closed)).toBe(true);
    expect(net.mediaLinks.every((l) => l.closed)).toBe(true);
    expect(a.signaling.uid).toBe(uidOf(0));
  });

  it("dispose is idempotent", () => {
    const { a, b } = pair();
    formGroup(net, [a, b]);
    a.session.dispose();
    a.session.dispose();
    expect(a.sessionEnded).toBe(1);
  });
});
