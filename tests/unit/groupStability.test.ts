/**
 * PA-006B regression tests: message reordering across different channels, partial commit,
 * resource cleanup after repeated sessions, low-bandwidth bookkeeping, protocol mismatch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOW_BANDWIDTH_THRESHOLD, TIMEOUTS } from "../../src/core/config";
import { approveAll, FakeNetwork, formGroup, incomingOf, memberIds, uidOf, type NetDataLink, type NetNode } from "./fakeNetwork";

let net: FakeNetwork;
beforeEach(() => {
  vi.useFakeTimers();
  net = new FakeNetwork();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};

function nodes(n: number): NetNode[] {
  return Array.from({ length: n }, (_, i) => net.add(uidOf(i), `P${i}`));
}

/** Debug-only view of private state for leak checks (tests only). */
function internals(n: NetNode) {
  const s = n.session as unknown as {
    limiters: Map<unknown, unknown>;
    unauthenticated: Map<unknown, unknown>;
    members: Map<unknown, unknown>;
    admission: unknown;
    joining: unknown;
  };
  const sp = n.speaker as unknown as { remotes: Map<unknown, unknown> };
  const mic = n.mic as unknown as { senders: Set<unknown> };
  return {
    limiters: s.limiters.size,
    unauth: s.unauthenticated.size,
    members: s.members.size,
    admission: s.admission,
    joining: s.joining,
    remotes: sp.remotes.size,
    senders: mic.senders.size,
  };
}

describe("cross-channel ordering (root cause of the 10-person flake)", () => {
  it("messages from a newcomer that overtake the coordinator's commit are not lost", () => {
    const [a, b, c, d] = nodes(4) as [NetNode, NetNode, NetNode, NetNode];
    formGroup(net, [a, b]);
    net.hold(b.uid, a.uid, "admit-commit"); // A learns about the commit late
    c.session.requestJoin(b.uid);
    net.settle();
    approveAll(net, [a, b]);
    net.settle();
    // C and B have committed; A has not received the commit yet.
    expect(memberIds(c)).toEqual([a.uid, b.uid].sort());
    expect(memberIds(a)).toEqual([b.uid]);

    // C immediately behaves as a member: chats and coordinates the next admission.
    c.session.sendChat("erken mesaj");
    d.session.requestJoin(c.uid);
    net.settle();
    expect(a.session.snapshot().chat.some((e) => e.text === "erken mesaj")).toBe(false); // not before A's own commit

    net.release();
    net.settle();
    expect(memberIds(a)).toEqual([b.uid, c.uid].sort());
    expect(a.session.snapshot().chat.some((e) => e.text === "erken mesaj")).toBe(true);
    expect(incomingOf(a)?.peerId).toBe(d.uid); // C's proposal was kept and evaluated after commit

    approveAll(net, [a, b, c]);
    net.settle();
    for (const n of [a, b, c, d]) expect([n.uid, ...memberIds(n)].sort()).toEqual([a.uid, b.uid, c.uid, d.uid].sort());
  });

  it("a proposal that arrives while our own admission is still connecting is deferred, not refused", () => {
    const [a, b, c, d] = nodes(4) as [NetNode, NetNode, NetNode, NetNode];
    formGroup(net, [a, b]);
    net.hold(b.uid, a.uid, "admit-commit");
    c.session.requestJoin(b.uid);
    net.settle();
    approveAll(net, [a, b]);
    net.settle();
    d.session.requestJoin(b.uid); // B already counts C; A is still connecting C
    net.settle();
    expect(d.session.snapshot().phase).toBe("requesting");
    net.release();
    net.settle();
    expect(incomingOf(a)?.peerId).toBe(d.uid);
    approveAll(net, [a, b, c]);
    net.settle();
    expect(memberIds(d)).toEqual([a.uid, b.uid, c.uid].sort());
  });

  it("buffered newcomer messages are discarded if the admission is rolled back", () => {
    const [a, b, c] = nodes(3) as [NetNode, NetNode, NetNode];
    formGroup(net, [a, b]);
    net.hold(b.uid, a.uid, "admit-commit");
    c.session.requestJoin(b.uid);
    net.settle();
    approveAll(net, [a, b]);
    net.settle();
    c.session.sendChat("geri alınacak");
    net.settle();
    vi.advanceTimersByTime(TIMEOUTS.meshSetupMs + TIMEOUTS.localSlackMs + 1); // A never got the commit
    net.settle();
    expect(memberIds(a)).toEqual([b.uid]);
    expect(a.session.snapshot().chat.some((e) => e.text === "geri alınacak")).toBe(false);
    expect(a.senders.has(c.uid)).toBe(false);
    expect(a.remoteStreams.has(c.uid)).toBe(false);
    net.release(); // the late commit must not resurrect the rolled-back admission
    net.settle();
    expect(memberIds(a)).toEqual([b.uid]);
  });
});

describe("protocol compatibility", () => {
  it("a v2 client asking a v1 client sees an explicit version error and keeps nothing open", () => {
    const [a] = nodes(1) as [NetNode];
    const old = net.add(uidOf(5), "old");
    // Simulate the 0.0.2 client: it answers any v2 request with a v1 rejection and closes.
    old.signaling.events.on("incomingData", (link) => {
      link.onData(() => {
        link.send({ t: "join-reject", v: 1, reason: "invalid" });
        link.close();
      });
    });
    a.session.requestJoin(old.uid);
    net.settle();
    expect(a.session.snapshot().phase).toBe("idle");
    expect(a.session.snapshot().notice?.text).toMatch(/farklı bir PsstAmigo sürümü/);
    expect(a.gum).not.toHaveBeenCalled();
    expect(internals(a).limiters).toBe(0);
  });

  it.each([{ t: "join-request", name: "x" }, { t: "join-request", v: "2", name: "x" }, { t: "join-request", v: 99, name: "x" }])(
    "rejects missing / malformed / future versions without side effects (%#)",
    (msg) => {
      const [a] = nodes(1) as [NetNode];
      const s = net.add(uidOf(5), "s");
      const link = net.connect(s.uid, a.uid) as NetDataLink;
      net.settle();
      link.send(msg);
      net.settle();
      expect(link.closed).toBe(true);
      expect(a.session.snapshot().incoming).toHaveLength(0);
      expect(internals(a).limiters).toBe(0);
    },
  );
});

describe("resource cleanup", () => {
  it("repeated join/leave cycles leave no links, timers, senders or playback behind", async () => {
    const [a, b, c] = nodes(3) as [NetNode, NetNode, NetNode];
    for (let i = 0; i < 15; i++) {
      formGroup(net, [a, b, c]);
      await a.mic.enable();
      a.speaker.enable();
      a.session.sendChat(`tur ${i}`);
      net.settle();
      for (const n of [c, b, a]) n.session.leave();
      net.settle();
      await flush();
    }
    for (const n of [a, b, c]) {
      const x = internals(n);
      expect(x).toMatchObject({ limiters: 0, unauth: 0, members: 0, admission: null, joining: null, remotes: 0, senders: 0 });
      expect(n.session.snapshot().chat).toHaveLength(0);
    }
    expect(a.capturedTracks.every((t) => t.readyState === "ended")).toBe(true);
    expect(a.players.every((p) => !p.playing)).toBe(true);
    expect(net.dataLinks.every((l) => l.closed)).toBe(true);
    expect(net.mediaLinks.every((l) => l.closed)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("low-bandwidth bookkeeping (D-020)", () => {
  it("reports when the bitrate cap could not be applied instead of claiming success", async () => {
    const g = nodes(LOW_BANDWIDTH_THRESHOLD + 1);
    formGroup(net, g.slice(0, LOW_BANDWIDTH_THRESHOLD));
    // Make one sender of node 0 refuse parameter changes.
    const broken = [...g[0]!.senders.values()][0]!;
    broken.setParameters = () => Promise.reject(new DOMException("nope", "InvalidModificationError"));
    g[LOW_BANDWIDTH_THRESHOLD]!.session.requestJoin(g[1]!.uid);
    net.settle();
    approveAll(net, g.slice(0, LOW_BANDWIDTH_THRESHOLD));
    net.settle();
    await flush();
    expect(g[0]!.session.snapshot().lowBandwidth).toBe(true);
    expect(g[0]!.session.snapshot().bandwidthLimitFailed).toBe(true);
    expect(g[1]!.session.snapshot().bandwidthLimitFailed).toBe(false);
  });

  it("does not touch encoder parameters again when nothing changed", async () => {
    const g = nodes(LOW_BANDWIDTH_THRESHOLD + 1);
    formGroup(net, g);
    await flush();
    const s = [...g[0]!.senders.values()][0]!;
    const spy = vi.spyOn(s, "setParameters");
    g[0]!.session.sendChat("x");
    await g[0]!.mic.enable();
    g[0]!.mic.disable();
    net.settle();
    await flush();
    expect(spy).not.toHaveBeenCalled();
    expect(s.params.encodings[0]?.maxBitrate).toBe(16_000); // mic toggling keeps the cap
  });
});

describe("vanished peers (no close event) — PA-006B HIGH finding", () => {
  it("a member whose transport stays disconnected is removed after the grace period", async () => {
    const [a, b, c] = nodes(3) as [NetNode, NetNode, NetNode];
    formGroup(net, [a, b, c]);
    await a.mic.enable();
    a.speaker.enable();
    net.vanish(c.uid);
    net.settle();
    expect(memberIds(a)).toEqual([b.uid, c.uid].sort()); // not removed on a short blip
    vi.advanceTimersByTime(TIMEOUTS.peerLostMs - 1_000);
    expect(memberIds(a)).toContain(c.uid);
    vi.advanceTimersByTime(1_001);
    net.settle();
    expect(memberIds(a)).toEqual([b.uid]);
    expect(memberIds(b)).toEqual([a.uid]);
    expect(a.senders.has(c.uid)).toBe(false);
    expect(a.remoteStreams.has(c.uid)).toBe(false);
    expect(a.mic.snapshot().state).toBe("on"); // others' audio state untouched
    expect(a.session.snapshot().chat.some((e) => /bağlantı koptu/.test(e.text))).toBe(true);

    // Admissions work again (the vanished member no longer blocks votes).
    const d = net.add(uidOf(3), "P3");
    d.session.requestJoin(b.uid);
    net.settle();
    approveAll(net, [a, b]);
    net.settle();
    expect(memberIds(d)).toEqual([a.uid, b.uid].sort());
  });

  it("a short interruption that recovers does not remove anyone", () => {
    const [a, b] = nodes(2) as [NetNode, NetNode];
    formGroup(net, [a, b]);
    const link = net.openLinksBetween(a.uid, b.uid)[0]!.other; // A's side
    link.pc.setIce("disconnected");
    vi.advanceTimersByTime(TIMEOUTS.peerLostMs - 5_000);
    link.pc.setIce("connected");
    vi.advanceTimersByTime(TIMEOUTS.peerLostMs);
    net.settle();
    expect(memberIds(a)).toEqual([b.uid]);
  });

  it("the last other member vanishing returns us to safe idle", async () => {
    const [a, b] = nodes(2) as [NetNode, NetNode];
    formGroup(net, [a, b]);
    await a.mic.enable();
    net.vanish(b.uid);
    vi.advanceTimersByTime(TIMEOUTS.peerLostMs + 1);
    net.settle();
    expect(a.session.snapshot().phase).toBe("idle");
    expect(a.mic.snapshot().state).toBe("off");
    expect(a.capturedTracks.every((t) => t.readyState === "ended")).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
