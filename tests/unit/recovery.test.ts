/**
 * PA-011 deterministic recovery tests (fake clock, in-memory transports).
 * "Simulated transport failure" only: real network interruption is a manual test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOW_BANDWIDTH_BITRATE_BPS, LOW_BANDWIDTH_THRESHOLD, MEDIA_RECOVERY, TIMEOUTS } from "../../src/core/config";
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
const mediaOf = (n: NetNode, peer: NetNode) => n.session.snapshot().participants.find((p) => p.peerId === peer.uid)?.media;
/** Runs one full recovery cycle: first backoff step, request/ok/call, ICE connect. */
function runRecovery(): void {
  vi.advanceTimersByTime(MEDIA_RECOVERY.delaysMs[0]!);
  net.settle();
}

describe("media-only recovery (REC-007, D-029)", () => {
  it("replaces a failed media connection while the data link stays; one media link per pair", () => {
    const [a, b] = nodes(2) as [NetNode, NetNode];
    formGroup(net, [a, b]);
    net.failMediaPair(a.uid, b.uid);
    net.settle();
    expect(mediaOf(a, b)).toBe("recovering");
    expect(mediaOf(b, a)).toBe("recovering");
    expect(memberIds(a)).toEqual([b.uid]); // not a departure
    runRecovery();
    expect(mediaOf(a, b)).toBe("connected");
    expect(mediaOf(b, a)).toBe("connected");
    expect(net.openMediaBetween(a.uid, b.uid)).toHaveLength(1);
    expect(net.openMediaBetween(b.uid, a.uid)).toHaveLength(1);
    expect(a.session.snapshot().chat.some((e) => /ses yeniden bağlandı/.test(e.text))).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the CURRENT mic state: live track if on, nothing if muted during the outage; never a new capture", async () => {
    const [a, b] = nodes(2) as [NetNode, NetNode];
    formGroup(net, [a, b]);
    await a.mic.enable();
    await b.mic.enable();
    net.failMediaPair(a.uid, b.uid);
    net.settle();
    b.mic.disable(); // B mutes while the connection is down
    runRecovery();
    await flush();
    expect(a.senders.get(b.uid)?.track).toBe(a.capturedTracks[0]); // still on: resumes to the same approved member
    expect(b.senders.get(a.uid)?.track).toBeNull(); // muted stays muted
    expect(a.gum).toHaveBeenCalledTimes(1);
    expect(b.gum).toHaveBeenCalledTimes(1);
    expect(b.capturedTracks.every((t) => t.readyState === "ended")).toBe(true);
  });

  it("speaker turned off during the outage stays off after recovery", () => {
    const [a, b] = nodes(2) as [NetNode, NetNode];
    formGroup(net, [a, b]);
    a.speaker.enable();
    net.failMediaPair(a.uid, b.uid);
    net.settle();
    expect(a.players.filter((p) => p.playing)).toHaveLength(0); // failed media stops playback
    a.speaker.disable();
    runRecovery();
    expect(a.remoteStreams.has(b.uid)).toBe(true);
    expect(a.players.filter((p) => p.playing)).toHaveLength(0);
    expect(a.speaker.isEnabled()).toBe(false);
  });

  it("gives up after the bounded attempts; chat keeps working and no timer is left", () => {
    const [a, b] = nodes(2) as [NetNode, NetNode];
    formGroup(net, [a, b]);
    net.block(a.uid, b.uid); // replacement calls never connect (e.g. NAT)
    net.failMediaPair(a.uid, b.uid);
    net.settle();
    for (const d of MEDIA_RECOVERY.delaysMs) {
      vi.advanceTimersByTime(d);
      net.settle();
      vi.advanceTimersByTime(MEDIA_RECOVERY.attemptTimeoutMs);
      net.settle();
    }
    vi.advanceTimersByTime(60_000);
    net.settle();
    expect(mediaOf(a, b)).toBe("failed");
    expect(mediaOf(b, a)).toBe("failed");
    expect(a.session.snapshot().chat.some((e) => /ses kurulamadı; mesajlaşma kullanılabilir/.test(e.text))).toBe(true);
    expect(net.mediaLinks.filter((l) => !l.closed)).toHaveLength(0);
    expect(a.session.sendChat("yazıyla devam")).toBe(true);
    net.settle();
    expect(b.session.snapshot().chat.some((e) => e.text === "yazıyla devam")).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("media stuck in 'disconnected' with a healthy data link is replaced after the stall timeout", () => {
    const [a, b] = nodes(2) as [NetNode, NetNode];
    formGroup(net, [a, b]);
    const pcA = net.openMediaBetween(a.uid, b.uid)[0]!.pc!; // A's side of the A–B media link
    pcA.setIce("disconnected");
    expect(mediaOf(a, b)).toBe("interrupted");
    vi.advanceTimersByTime(MEDIA_RECOVERY.stallMs - 1);
    expect(mediaOf(a, b)).toBe("interrupted"); // give the same connection time first (Scenario B)
    vi.advanceTimersByTime(1);
    net.settle();
    expect(mediaOf(a, b)).toBe("recovering");
    runRecovery();
    expect(mediaOf(a, b)).toBe("connected");
  });

  it("a short media interruption recovers on the same connection without replacement", () => {
    const [a, b] = nodes(2) as [NetNode, NetNode];
    formGroup(net, [a, b]);
    const link = net.openMediaBetween(a.uid, b.uid)[0]!;
    link.pc!.setIce("disconnected"); // A's side
    expect(mediaOf(a, b)).toBe("interrupted");
    vi.advanceTimersByTime(5_000);
    link.pc!.setIce("connected");
    vi.advanceTimersByTime(60_000);
    net.settle();
    expect(mediaOf(a, b)).toBe("connected");
    expect(net.mediaLinks).toHaveLength(2); // still the original pair of endpoints
  });

  it("ignores recovery requests from non-members, stale generations and the wrong role", () => {
    const [a, b] = nodes(2) as [NetNode, NetNode];
    formGroup(net, [a, b]);
    const sid = (net.dataLinks.find((l) => l.sent.some((m) => (m as { sid?: string }).sid))?.sent.find((m) => (m as { sid?: string }).sid) as { sid: string }).sid;
    // B (higher UID) is the responder; B asking A is the wrong role and must be ignored.
    net.openLinksBetween(b.uid, a.uid)[0]!.send({ t: "media-recover", v: 2, sid, gen: 1 }); // B's side → A
    net.settle();
    expect(mediaOf(a, b)).toBe("connected");
    // A stranger cannot use the recovery path.
    const s = net.add(uidOf(7), "S");
    const strangerLink = net.connect(s.uid, a.uid) as NetDataLink;
    net.settle();
    strangerLink.send({ t: "media-recover", v: 2, sid, gen: 1 });
    net.settle();
    expect(strangerLink.closed).toBe(true);
    net.call(s.uid, a.uid, { getAudioTracks: () => [], getTracks: () => [] } as unknown as MediaStream);
    net.settle();
    expect(net.mediaLinks.some((l) => l.answered && l.peerId === s.uid)).toBe(false);
  });

  it("recovered senders get the low-bandwidth profile", async () => {
    const g = nodes(LOW_BANDWIDTH_THRESHOLD + 1);
    formGroup(net, g);
    await flush();
    net.failMediaPair(g[0]!.uid, g[1]!.uid);
    net.settle();
    runRecovery();
    await flush();
    expect(g[0]!.senders.get(g[1]!.uid)?.params.encodings[0]?.maxBitrate).toBe(LOW_BANDWIDTH_BITRATE_BPS);
    expect(g[0]!.session.snapshot().lowBandwidth).toBe(true);
  });

  it("10 participants: one failing pair recovers, the others are untouched", () => {
    const g = nodes(10);
    formGroup(net, g);
    const before = net.mediaLinks.filter((l) => !l.closed).length;
    net.failMediaPair(g[3]!.uid, g[7]!.uid);
    net.settle();
    expect(mediaOf(g[3]!, g[7]!)).toBe("recovering");
    expect(mediaOf(g[3]!, g[2]!)).toBe("connected");
    runRecovery();
    expect(mediaOf(g[3]!, g[7]!)).toBe("connected");
    expect(net.mediaLinks.filter((l) => !l.closed).length).toBe(before);
  });

  it("participant leaving during recovery cancels everything", () => {
    const [a, b, c] = nodes(3) as [NetNode, NetNode, NetNode];
    formGroup(net, [a, b, c]);
    net.failMediaPair(a.uid, c.uid);
    net.settle();
    c.session.leave();
    net.settle();
    runRecovery();
    vi.advanceTimersByTime(120_000);
    net.settle();
    expect(memberIds(a)).toEqual([b.uid]);
    expect(net.mediaLinks.filter((l) => !l.closed && (l.peerId === c.uid || l.other.peerId === c.uid))).toHaveLength(0);
  });

  it("repeated interruptions and recoveries leave no extra links or timers", () => {
    const [a, b] = nodes(2) as [NetNode, NetNode];
    formGroup(net, [a, b]);
    for (let i = 0; i < 6; i++) {
      net.failMediaPair(a.uid, b.uid);
      net.settle();
      runRecovery();
      expect(mediaOf(a, b)).toBe("connected");
    }
    expect(net.mediaLinks.filter((l) => !l.closed)).toHaveLength(2);
    expect(net.dataLinks.filter((l) => !l.closed)).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("membership convergence (REC-009…011, D-030)", () => {
  it("partial commit: the newcomer not committed by everyone is removed; the others converge", () => {
    const [a, b, c, d] = nodes(4) as [NetNode, NetNode, NetNode, NetNode];
    formGroup(net, [a, b, d]);
    net.hold(b.uid, a.uid, "admit-commit"); // the commit never reaches A
    c.session.requestJoin(b.uid);
    net.settle();
    approveAll(net, [a, b, d]);
    net.settle();
    expect(memberIds(c)).toEqual([a.uid, b.uid, d.uid].sort()); // C believes it joined
    vi.advanceTimersByTime(TIMEOUTS.meshSetupMs + TIMEOUTS.localSlackMs + 1); // A rolls back
    net.settle();
    vi.advanceTimersByTime(TIMEOUTS.memberSyncGraceMs + 1);
    net.settle();
    vi.advanceTimersByTime(TIMEOUTS.memberSyncGraceMs + 1);
    net.settle();
    for (const n of [a, b, d]) expect([n.uid, ...memberIds(n)].sort()).toEqual([a.uid, b.uid, d.uid].sort());
    expect(c.session.snapshot().phase).toBe("idle");
    expect(c.session.snapshot().rejoinTarget).not.toBeNull();
    // A never sent or played audio for C.
    expect(a.senders.has(c.uid)).toBe(false);
    expect(a.remoteStreams.has(c.uid)).toBe(false);
  });

  it("a normal leave racing a sync report does not remove anyone else", () => {
    const [a, b, c, d] = nodes(4) as [NetNode, NetNode, NetNode, NetNode];
    formGroup(net, [a, b, c, d]);
    net.hold(a.uid, c.uid, "leave"); // C learns about A's leave late
    a.session.leave();
    net.settle(); // B and D already removed A and report their views to C
    net.release();
    vi.advanceTimersByTime(TIMEOUTS.memberSyncGraceMs + 1);
    net.settle();
    for (const n of [b, c, d]) expect([n.uid, ...memberIds(n)].sort()).toEqual([b.uid, c.uid, d.uid].sort());
  });

  it("network partition splits into two consistent groups and never merges back automatically", () => {
    const [a, b, c, d] = nodes(4) as [NetNode, NetNode, NetNode, NetNode];
    formGroup(net, [a, b, c, d]);
    for (const x of [a, b]) for (const y of [c, d]) net.disconnectPair(x.uid, y.uid);
    vi.advanceTimersByTime(TIMEOUTS.peerLostMs + 1);
    net.settle();
    vi.advanceTimersByTime(TIMEOUTS.memberSyncGraceMs + 1);
    net.settle();
    expect(memberIds(a)).toEqual([b.uid]);
    expect(memberIds(b)).toEqual([a.uid]);
    expect(memberIds(c)).toEqual([d.uid]);
    expect(memberIds(d)).toEqual([c.uid]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a removed participant cannot come back without a new unanimous admission", () => {
    const [a, b, c] = nodes(3) as [NetNode, NetNode, NetNode];
    formGroup(net, [a, b, c]);
    net.vanish(c.uid);
    vi.advanceTimersByTime(TIMEOUTS.peerLostMs + 1);
    net.settle();
    expect(memberIds(a)).toEqual([b.uid]);
    // C "comes back" with its old identity: recovery or mesh messages are refused...
    const back = net.add(c.uid, "P2");
    const l = net.connect(back.uid, a.uid) as NetDataLink;
    net.settle();
    l.send({ t: "mesh-hello", v: 2, sid: "a".repeat(32), aid: "b".repeat(32) });
    net.settle();
    expect(l.closed).toBe(true);
    // ...only a normal request works, and it needs everyone's approval again.
    back.session.requestJoin(a.uid);
    net.settle();
    expect(incomingOf(a)?.peerId).toBe(c.uid);
    expect(incomingOf(b)?.peerId).toBe(c.uid);
    approveAll(net, [a, b]);
    net.settle();
    expect(memberIds(back)).toEqual([a.uid, b.uid].sort());
  });

  it("coordinator crash during commit: no one keeps a newcomer without the full mesh", () => {
    const [a, b, c, d] = nodes(4) as [NetNode, NetNode, NetNode, NetNode];
    formGroup(net, [a, b, d]);
    net.hold(b.uid, a.uid, "admit-commit");
    net.hold(b.uid, d.uid, "admit-commit");
    c.session.requestJoin(b.uid);
    net.settle();
    approveAll(net, [a, b, d]);
    net.settle();
    net.vanish(b.uid); // coordinator dies after only C got the commit
    vi.advanceTimersByTime(TIMEOUTS.meshSetupMs + TIMEOUTS.localSlackMs + 1);
    net.settle();
    vi.advanceTimersByTime(TIMEOUTS.peerLostMs + TIMEOUTS.memberSyncGraceMs * 2);
    net.settle();
    expect(memberIds(a)).toEqual([d.uid]);
    expect(memberIds(d)).toEqual([a.uid]);
    expect(c.session.snapshot().phase).toBe("idle");
    expect(a.senders.has(c.uid) || d.senders.has(c.uid)).toBe(false);
  });
});
