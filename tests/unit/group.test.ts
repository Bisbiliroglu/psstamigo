/**
 * PA-006 group mesh regression tests on the in-memory network (real SessionController,
 * MicrophoneController and SpeakerController per node).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOW_BANDWIDTH_BITRATE_BPS, LOW_BANDWIDTH_THRESHOLD, MAX_PARTICIPANTS, TIMEOUTS } from "../../src/core/config";
import {
  approveAll,
  FakeNetwork,
  formGroup,
  incomingOf,
  memberIds,
  uidOf,
  type NetDataLink,
  type NetNode,
} from "./fakeNetwork";

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
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

const NAMES = ["Ayla", "Bora", "Cem", "Deniz", "Ece", "Fırat", "Gül", "Hakan", "Irmak", "Jale", "Kaan", "Lale"];
function nodes(n: number): NetNode[] {
  return Array.from({ length: n }, (_, i) => net.add(uidOf(i), NAMES[i]!));
}

/** Every pair has exactly one open application data link and one open media link. */
function expectFullMesh(group: NetNode[]): void {
  for (const x of group) {
    expect(memberIds(x)).toEqual(group.filter((y) => y !== x).map((y) => y.uid).sort());
    for (const y of group) {
      if (x === y) continue;
      expect(net.openLinksBetween(x.uid, y.uid)).toHaveLength(1);
      expect(net.openMediaBetween(x.uid, y.uid)).toHaveLength(1);
    }
  }
}

/** Raw application link from `from` to `to` (as seen by `from`). */
function linkFrom(from: NetNode, to: NetNode): NetDataLink {
  const l = net.openLinksBetween(to.uid, from.uid)[0];
  if (!l) throw new Error("no link");
  return l.other; // `from`'s side of the pair
}

function sidOf(node: NetNode): string {
  // Read the session id from a chat message the node sends (test-only introspection).
  node.session.sendChat("sid-probe");
  const peer = [...net.dataLinks].reverse().find((l) => l.other.peerId === node.uid && l.sent.length > 0) ?? null;
  const msg = (peer?.sent.at(-1) ?? {}) as { sid?: string };
  net.settle();
  return msg.sid ?? "";
}

describe("group admission (GR-002, GR-005)", () => {
  it("C joins A+B through the non-initiator B only after BOTH approve", () => {
    const [a, b, c] = nodes(3) as [NetNode, NetNode, NetNode];
    formGroup(net, [a, b]);
    c.session.requestJoin(b.uid);
    net.settle();

    // Both members see the request; C learns nothing about A and has no links to A.
    expect(incomingOf(a)).toMatchObject({ peerId: c.uid, via: { peerId: b.uid } });
    expect(incomingOf(b)).toMatchObject({ peerId: c.uid, via: null, approvals: 0, required: 2 });
    expect(c.session.snapshot().joinStage).toBe("approval");
    expect(net.dataLinks.some((l) => l.peerId === a.uid && l.other.peerId === c.uid)).toBe(false);

    a.session.acceptRequest(incomingOf(a)!.id);
    net.settle();
    expect(c.session.snapshot().joinStage).toBe("approval"); // B has not approved yet
    expect(incomingOf(b)?.approvals).toBe(1);

    b.session.acceptRequest(incomingOf(b)!.id);
    net.settle();
    expectFullMesh([a, b, c]);
    for (const n of [a, b, c]) expect(n.session.snapshot().capacity.count).toBe(3);
    expect(a.session.snapshot().chat.some((e) => e.kind === "system" && /Cem görüşmeye katıldı/.test(e.text))).toBe(true);
  });

  it("supports MAX_PARTICIPANTS (10 → 45 pairs) and rejects one more as full (GR-004)", () => {
    expect(MAX_PARTICIPANTS).toBe(10);
    const all = nodes(MAX_PARTICIPANTS);
    formGroup(net, all);
    expectFullMesh(all);
    const pairs = (MAX_PARTICIPANTS * (MAX_PARTICIPANTS - 1)) / 2;
    expect(net.dataLinks.filter((l) => !l.closed).length / 2).toBe(pairs);
    expect(net.mediaLinks.filter((l) => !l.closed).length / 2).toBe(pairs);
    expect(all[0]!.session.snapshot().capacity).toEqual({ count: MAX_PARTICIPANTS, max: MAX_PARTICIPANTS });

    const extra = net.add(uidOf(MAX_PARTICIPANTS), "Fazla");
    extra.session.requestJoin(all[2]!.uid);
    net.settle();
    expect(extra.session.snapshot().phase).toBe("idle");
    expect(extra.session.snapshot().notice?.text).toMatch(/kapasitesi dolu/);
    expect(all.every((n) => n.session.snapshot().incoming.length === 0)).toBe(true);
  });

  it("switches to low-bandwidth mode above the threshold and back (D-020)", async () => {
    const g = nodes(LOW_BANDWIDTH_THRESHOLD + 1);
    formGroup(net, g.slice(0, LOW_BANDWIDTH_THRESHOLD));
    await flush();
    const a = g[0]!;
    expect(a.session.snapshot().lowBandwidth).toBe(false);
    expect([...a.senders.values()].every((s) => s.params.encodings[0]?.maxBitrate === undefined)).toBe(true);

    g[LOW_BANDWIDTH_THRESHOLD]!.session.requestJoin(g[1]!.uid);
    net.settle();
    approveAll(net, g.slice(0, LOW_BANDWIDTH_THRESHOLD));
    net.settle();
    await flush();
    for (const n of g) {
      expect(n.session.snapshot().lowBandwidth).toBe(true);
      expect([...n.senders.values()].every((s) => s.params.encodings[0]?.maxBitrate === LOW_BANDWIDTH_BITRATE_BPS)).toBe(true);
      expect(n.senders.size).toBe(LOW_BANDWIDTH_THRESHOLD);
    }
    // Mic privacy is unaffected by the bitrate change.
    expect([...a.senders.values()].every((s) => s.track === null)).toBe(true);

    g[LOW_BANDWIDTH_THRESHOLD]!.session.leave();
    net.settle();
    await flush();
    expect(a.session.snapshot().lowBandwidth).toBe(false);
    expect([...a.senders.values()].every((s) => s.params.encodings[0]?.maxBitrate === undefined)).toBe(true);
  });

  it("a single rejection aborts the admission without disturbing the session", () => {
    const [a, b, c] = nodes(3) as [NetNode, NetNode, NetNode];
    formGroup(net, [a, b]);
    c.session.requestJoin(b.uid);
    net.settle();
    b.session.acceptRequest(incomingOf(b)!.id);
    a.session.rejectRequest(incomingOf(a)!.id);
    net.settle();
    expect(c.session.snapshot().phase).toBe("idle");
    expect(c.session.snapshot().notice?.text).toMatch(/reddedildi/);
    expect(memberIds(a)).toEqual([b.uid]);
    expect(memberIds(b)).toEqual([a.uid]);
    expect(net.dataLinks.filter((l) => !l.closed && (l.peerId === c.uid || l.other.peerId === c.uid))).toHaveLength(0);
  });

  it("times out if a member never votes", () => {
    const [a, b, c] = nodes(3) as [NetNode, NetNode, NetNode];
    formGroup(net, [a, b]);
    c.session.requestJoin(b.uid);
    net.settle();
    b.session.acceptRequest(incomingOf(b)!.id);
    net.settle();
    vi.advanceTimersByTime(TIMEOUTS.admissionVoteMs + 1);
    net.settle();
    for (const n of [a, b]) expect(n.session.snapshot().incoming).toHaveLength(0);
    expect(c.session.snapshot().phase).toBe("idle");
    expectFullMesh([a, b]);
  });

  it("duplicate approvals count once; candidates and forged votes cannot approve", () => {
    const [a, b, c, d] = nodes(4) as [NetNode, NetNode, NetNode, NetNode];
    formGroup(net, [a, b, d]);
    c.session.requestJoin(b.uid);
    net.settle();
    const aid = (net.dataLinks.find((l) => l.peerId === b.uid && l.other.peerId === c.uid)?.other.sent[0] as { aid: string })
      ?.aid;
    expect(aid).toMatch(/^[0-9a-f]{32}$/);
    const sid = (linkFrom(b, a).sent.find((m) => (m as { t: string }).t === "admit-propose") as { sid: string }).sid;

    a.session.acceptRequest(incomingOf(a)!.id);
    net.settle();
    // A repeats its vote; D's vote is forged by A on A's own link; the candidate votes for itself.
    linkFrom(a, b).send({ t: "admit-vote", v: 2, sid, aid, vote: "accept" });
    linkFrom(a, b).send({ t: "admit-vote", v: 2, sid, aid, vote: "accept" });
    const cToB = net.dataLinks.find((l) => l.other.peerId === b.uid && l.peerId === c.uid && !l.closed);
    cToB?.send({ t: "admit-vote", v: 2, sid, aid, vote: "accept" });
    net.settle();
    expect(incomingOf(b)?.approvals).toBe(1); // only A counted, once
    b.session.acceptRequest(incomingOf(b)!.id);
    net.settle();
    expect(c.session.snapshot().joinStage).toBe("approval"); // D has not approved: still waiting
    d.session.acceptRequest(incomingOf(d)!.id);
    net.settle();
    expectFullMesh([a, b, c, d]);
  });

  it("a member that did not approve refuses the candidate's mesh link even if told otherwise", () => {
    const [a, b, c] = nodes(3) as [NetNode, NetNode, NetNode];
    formGroup(net, [a, b]);
    c.session.requestJoin(b.uid);
    net.settle();
    const aid = (net.dataLinks.find((l) => l.peerId === b.uid && l.other.peerId === c.uid)?.other.sent[0] as { aid: string }).aid;
    const sid = (linkFrom(b, a).sent.find((m) => (m as { t: string }).t === "admit-propose") as { sid: string }).sid;
    // C (or a malicious coordinator's hint) tries to reach A before A approved.
    const hello = net.connect(c.uid, a.uid) as NetDataLink;
    net.settle();
    hello.send({ t: "mesh-hello", v: 2, sid, aid });
    net.settle();
    expect(hello.closed).toBe(true);
    net.call(c.uid, a.uid, { getAudioTracks: () => [], getTracks: () => [] } as unknown as MediaStream);
    net.settle();
    expect(net.mediaLinks.some((l) => l.answered && l.peerId === c.uid)).toBe(false);
  });

  it("rejects proposals whose member snapshot does not match (stale / conflicting membership)", () => {
    const [a, b, d] = nodes(4).filter((_, i) => i !== 2) as [NetNode, NetNode, NetNode];
    formGroup(net, [a, b, d]);
    const sid = sidOf(a);
    linkFrom(b, a).send({
      t: "admit-propose",
      v: 2,
      sid,
      aid: "a".repeat(32),
      candidate: uidOf(7),
      name: "X",
      members: [a.uid, b.uid].sort(), // D missing: stale view
    });
    net.settle();
    expect(a.session.snapshot().incoming).toHaveLength(0);
    expect(linkFrom(a, b).sent).toContainEqual({ t: "admit-vote", v: 2, sid, aid: "a".repeat(32), vote: "conflict" });
  });

  it("ignores replayed admission messages and messages with a foreign session id", () => {
    const [a, b, c] = nodes(3) as [NetNode, NetNode, NetNode];
    formGroup(net, [a, b, c]);
    const propose = linkFrom(b, a).sent.find((m) => (m as { t: string }).t === "admit-propose");
    expect(propose).toBeDefined();
    linkFrom(b, a).send(propose); // replay of an already finished admission
    linkFrom(b, a).send({ t: "chat", v: 2, sid: "f".repeat(32), id: "1".repeat(16), text: "foreign" });
    net.settle();
    expect(a.session.snapshot().incoming).toHaveLength(0);
    expect(a.session.snapshot().chat.some((e) => e.text === "foreign")).toBe(false);
  });

  it("simultaneous join requests never exceed capacity or split the membership", () => {
    const g = nodes(5);
    formGroup(net, g.slice(0, 4)); // 4 members
    const [x, y] = [g[4]!, net.add(uidOf(6), "Gül")];
    x.session.requestJoin(g[0]!.uid);
    y.session.requestJoin(g[3]!.uid);
    net.settle();
    for (let round = 0; round < 3; round++) approveAll(net, g.slice(0, 4));
    net.settle();
    const members0 = memberIds(g[0]!);
    for (const n of g.slice(1, 4)) expect([n.uid, ...memberIds(n)].sort()).toEqual([g[0]!.uid, ...members0].sort());
    expect(members0.length + 1).toBeLessThanOrEqual(MAX_PARTICIPANTS);
    expect(members0.includes(x.uid) && members0.includes(y.uid)).toBe(false); // at most one admitted
  });

  it("a second link from an existing member is dropped (no duplicate connections)", () => {
    const [a, b] = nodes(2) as [NetNode, NetNode];
    formGroup(net, [a, b]);
    const dup = net.connect(b.uid, a.uid) as NetDataLink;
    net.settle();
    dup.send({ t: "join-request", v: 2, name: "Bora" });
    net.settle();
    expect(dup.closed).toBe(true);
    expect(net.openLinksBetween(a.uid, b.uid)).toHaveLength(1);
  });

  it.each(["video", "unreadable", "invalid"] as const)("aborts the admission on a %s offer from the candidate (D-010)", (verdict) => {
    const [a, b, c] = nodes(3) as [NetNode, NetNode, NetNode];
    formGroup(net, [a, b]);
    net.verdicts.set(a.uid, verdict);
    c.session.requestJoin(b.uid);
    net.settle();
    approveAll(net, [a, b]);
    net.settle();
    expect(c.session.snapshot().phase).toBe("idle");
    expect(net.mediaLinks.some((l) => l.answered && l.peerId === c.uid && l.other.peerId !== b.uid && l.pc)).toBe(false);
    expectFullMesh([a, b]);
  });

  it("partial connection failure rolls the admission back (no TURN)", () => {
    const [a, b, c] = nodes(3) as [NetNode, NetNode, NetNode];
    formGroup(net, [a, b]);
    net.block(a.uid, c.uid);
    c.session.requestJoin(b.uid);
    net.settle();
    approveAll(net, [a, b]);
    net.settle();
    expect(c.session.snapshot().joinStage).toBe("connecting");
    vi.advanceTimersByTime(TIMEOUTS.meshSetupMs + 1);
    net.settle();
    expect(c.session.snapshot().phase).toBe("idle");
    expect(c.session.snapshot().notice?.text).toMatch(/bağlantı kurulamadı/);
    expectFullMesh([a, b]);
    expect(net.dataLinks.filter((l) => !l.closed && (l.peerId === c.uid || l.other.peerId === c.uid))).toHaveLength(0);
    expect(net.mediaLinks.filter((l) => !l.closed && (l.peerId === c.uid || l.other.peerId === c.uid))).toHaveLength(0);
  });

  it("candidate disconnecting during media setup aborts cleanly", () => {
    const [a, b, c] = nodes(3) as [NetNode, NetNode, NetNode];
    formGroup(net, [a, b]);
    net.block(a.uid, c.uid);
    c.session.requestJoin(b.uid);
    net.settle();
    approveAll(net, [a, b]);
    net.kill(c.uid);
    net.settle();
    for (const n of [a, b]) expect(n.session.snapshot().incoming).toHaveLength(0);
    expectFullMesh([a, b]);
  });
});

describe("departures (GR-008, GR-009)", () => {
  it("the initiator leaving keeps the others' session, mic, speaker and chat", async () => {
    const [a, b, c, d] = nodes(4) as [NetNode, NetNode, NetNode, NetNode];
    formGroup(net, [a, b, c, d]);
    await b.mic.enable();
    b.speaker.enable();
    b.session.sendChat("önce");
    net.settle();
    a.session.leave();
    net.settle();
    expectFullMesh([b, c, d]);
    expect(b.mic.snapshot().state).toBe("on");
    expect(b.speaker.isEnabled()).toBe(true);
    expect(c.session.snapshot().chat.some((e) => e.text === "önce")).toBe(true);
    expect(c.session.snapshot().chat.some((e) => /Ayla görüşmeden ayrıldı/.test(e.text))).toBe(true);
    expect(b.senders.has(a.uid)).toBe(false);
    expect(b.capturedTracks[0]?.readyState).toBe("live"); // shared capture untouched
    expect([...b.senders.values()].every((s) => s.track === b.capturedTracks[0])).toBe(true);
  });

  it("coordinator leaving during an admission aborts it; the rest continue", () => {
    const [a, b, c, d] = nodes(4) as [NetNode, NetNode, NetNode, NetNode];
    formGroup(net, [a, b, d]);
    c.session.requestJoin(b.uid);
    net.settle();
    a.session.acceptRequest(incomingOf(a)!.id);
    net.settle();
    b.session.leave();
    net.settle();
    expect(c.session.snapshot().phase).toBe("idle");
    for (const n of [a, d]) expect(n.session.snapshot().incoming).toHaveLength(0);
    expectFullMesh([a, d]);
  });

  it("another member leaving during an admission aborts it (membership changed)", () => {
    const [a, b, c, d] = nodes(4) as [NetNode, NetNode, NetNode, NetNode];
    formGroup(net, [a, b, d]);
    c.session.requestJoin(b.uid);
    net.settle();
    d.session.leave();
    net.settle();
    expect(c.session.snapshot().phase).toBe("idle");
    expectFullMesh([a, b]);
    expect(a.session.snapshot().incoming).toHaveLength(0);
  });

  it("a killed tab removes only that participant; the last one returns to safe idle", async () => {
    const [a, b, c] = nodes(3) as [NetNode, NetNode, NetNode];
    formGroup(net, [a, b, c]);
    await c.mic.enable();
    c.speaker.enable();
    net.kill(a.uid);
    net.settle();
    expectFullMesh([b, c]);
    b.session.leave();
    net.settle();
    expect(c.session.snapshot().phase).toBe("idle");
    expect(c.sessionEnded).toBe(1);
    expect(c.mic.snapshot().state).toBe("off");
    expect(c.capturedTracks.every((t) => t.readyState === "ended")).toBe(true);
    expect(c.speaker.isEnabled()).toBe(false);
    expect(c.session.snapshot().chat).toHaveLength(0);
    expect(c.signaling.uid).toBe(uidOf(2));
  });
});

describe("audio privacy in groups (6.x)", () => {
  async function joinCWith(setup: (a: NetNode, b: NetNode) => Promise<void> | void, during?: (a: NetNode, b: NetNode) => void) {
    const [a, b, c] = nodes(3) as [NetNode, NetNode, NetNode];
    formGroup(net, [a, b]);
    await setup(a, b);
    c.session.requestJoin(b.uid);
    net.settle();
    a.session.acceptRequest(incomingOf(a)!.id);
    net.settle();
    during?.(a, b);
    b.session.acceptRequest(incomingOf(b)!.id);
    net.settle();
    await flush();
    return { a, b, c };
  }

  it("newcomer gets live audio only after commit; mic-off members stay off; newcomer starts muted", async () => {
    const [a, b, c] = nodes(3) as [NetNode, NetNode, NetNode];
    formGroup(net, [a, b]);
    await a.mic.enable();
    c.session.requestJoin(b.uid);
    net.settle();
    approveAll(net, [a]);
    expect(a.senders.has(c.uid)).toBe(false); // no sender before commit
    approveAll(net, [b]);
    await flush();
    const aTrack = a.capturedTracks[0]!;
    expect(a.senders.get(c.uid)?.track).toBe(aTrack); // single capture shared
    expect(a.gum).toHaveBeenCalledTimes(1);
    expect(b.senders.get(c.uid)?.track).toBeNull(); // B's mic was off and stays off
    expect(b.gum).not.toHaveBeenCalled();
    expect(c.gum).not.toHaveBeenCalled();
    expect(c.mic.snapshot().state).toBe("off");
    expect(c.speaker.isEnabled()).toBe(false);
    expect(c.players.some((p) => p.playing)).toBe(false);
  });

  it("mic turned off during admission: newcomer never receives the old track", async () => {
    const { a, c } = await joinCWith(
      async (a) => {
        await a.mic.enable();
      },
      (a) => a.mic.disable(),
    );
    expect(a.senders.get(c.uid)?.track).toBeNull();
    expect(a.capturedTracks.every((t) => t.readyState === "ended")).toBe(true);
  });

  it("speaker turned off during admission: newcomer is not played", async () => {
    const { b } = await joinCWith(
      (_a, b) => b.speaker.enable(),
      (_a, b) => b.speaker.disable(),
    );
    expect(b.players.some((p) => p.playing)).toBe(false);
  });

  it("speaker on: the newcomer's stream joins playback only after commit", async () => {
    const [a, b, c] = nodes(3) as [NetNode, NetNode, NetNode];
    formGroup(net, [a, b]);
    b.speaker.enable();
    const before = b.players.filter((p) => p.playing).length;
    c.session.requestJoin(b.uid);
    net.settle();
    approveAll(net, [a]);
    b.session.acceptRequest(incomingOf(b)!.id);
    expect(b.remoteStreams.has(c.uid)).toBe(false); // not before commit
    net.settle();
    expect(b.remoteStreams.has(c.uid)).toBe(true);
    expect(b.players.filter((p) => p.playing).length).toBe(before + 1);
  });

  it("mic off stops the capture for ALL peers at once (full group)", async () => {
    const all = nodes(MAX_PARTICIPANTS);
    formGroup(net, all);
    const a = all[0]!;
    await a.mic.enable();
    await flush();
    expect([...a.senders.values()].filter((s) => s.track !== null)).toHaveLength(MAX_PARTICIPANTS - 1);
    a.mic.disable();
    await flush();
    expect([...a.senders.values()].every((s) => s.track === null)).toBe(true);
    expect(a.capturedTracks.every((t) => t.readyState === "ended")).toBe(true);
    expect(a.gum).toHaveBeenCalledTimes(1);
  });

  it("pending getUserMedia + participant departure: capture attaches only to remaining members", async () => {
    net.manualGum = true;
    const [a, b, c] = nodes(3) as [NetNode, NetNode, NetNode];
    formGroup(net, [a, b, c]);
    const pending = a.mic.enable();
    c.session.leave();
    net.settle();
    a.pendingGum[0]!.resolve();
    await pending;
    await flush();
    expect(a.senders.has(c.uid)).toBe(false);
    expect(a.senders.get(b.uid)?.track).toBe(a.capturedTracks[0]);
  });

  it("pending getUserMedia + session termination: the late capture is stopped", async () => {
    net.manualGum = true;
    const [a, b] = nodes(2) as [NetNode, NetNode];
    formGroup(net, [a, b]);
    const pending = a.mic.enable();
    b.session.leave();
    net.settle();
    a.pendingGum[0]!.resolve();
    await pending;
    expect(a.mic.snapshot().state).toBe("off");
    expect(a.capturedTracks[0]?.readyState).toBe("ended");
  });

  it("stale media callbacks after a session ended cannot start playback", () => {
    const [a, b] = nodes(2) as [NetNode, NetNode];
    formGroup(net, [a, b]);
    a.speaker.enable();
    const link = net.openMediaBetween(a.uid, b.uid)[0]!.other;
    b.session.leave();
    net.settle();
    link.emitStream({ getVideoTracks: () => [], getAudioTracks: () => [], getTracks: () => [] } as never);
    expect(a.remoteStreams.size).toBe(0);
    expect(a.players.some((p) => p.playing)).toBe(false);
  });
});

describe("group chat (GR-007, FR-015)", () => {
  it("fans out to every member; sender identity comes from the link", () => {
    const g = nodes(4);
    formGroup(net, g);
    g.forEach((n, i) => n.session.sendChat(`mesaj ${i}`));
    net.settle();
    for (const [i, n] of g.entries()) {
      const remote = n.session.snapshot().chat.filter((e) => e.kind === "chat" && !e.fromSelf);
      expect(remote.map((e) => e.text).sort()).toEqual(g.map((_, j) => `mesaj ${j}`).filter((_, j) => j !== i).sort());
      for (const e of remote) expect(e.senderUid).toBe(g[Number(e.text.split(" ")[1])]!.uid);
    }
  });

  it("drops duplicates, impersonation payloads and non-member senders; newcomers get no history", () => {
    const [a, b, c] = nodes(3) as [NetNode, NetNode, NetNode];
    formGroup(net, [a, b]);
    a.session.sendChat("eski mesaj");
    net.settle();
    const sid = sidOf(b);
    const msg = { t: "chat", v: 2, sid, id: "2".repeat(16), text: "tek" };
    linkFrom(b, a).send(msg);
    linkFrom(b, a).send(msg);
    linkFrom(b, a).send({ ...msg, id: "3".repeat(16), from: c.uid }); // extra field: rejected by schema
    net.settle();
    expect(a.session.snapshot().chat.filter((e) => e.text === "tek")).toHaveLength(1);
    expect(a.session.snapshot().chat.some((e) => e.senderUid === c.uid)).toBe(false);

    c.session.requestJoin(b.uid);
    net.settle();
    approveAll(net, [a, b]);
    net.settle();
    expect(c.session.snapshot().chat.some((e) => e.text === "eski mesaj")).toBe(false);
  });

  it("chat keeps working when one member's media failed", () => {
    const [a, b, c] = nodes(3) as [NetNode, NetNode, NetNode];
    formGroup(net, [a, b, c]);
    net.openMediaBetween(a.uid, c.uid)[0]!.pc!.setIce("failed");
    net.settle();
    expect(a.session.snapshot().participants.find((p) => p.peerId === c.uid)?.media).toBe("failed");
    c.session.sendChat("sesim yok ama yazabiliyorum");
    net.settle();
    expect(a.session.snapshot().chat.some((e) => e.text === "sesim yok ama yazabiliyorum")).toBe(true);
    // B–C unaffected
    expect(b.session.snapshot().participants.find((p) => p.peerId === c.uid)?.media).toBe("connected");
    expect(net.openMediaBetween(b.uid, c.uid)).toHaveLength(1);
  });

  it("cleanup is idempotent in a group", () => {
    const g = nodes(3);
    formGroup(net, g);
    g[0]!.session.dispose();
    g[0]!.session.dispose();
    net.settle();
    expect(g[0]!.sessionEnded).toBe(1);
    expectFullMesh(g.slice(1));
  });
});
