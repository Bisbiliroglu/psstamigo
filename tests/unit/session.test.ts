import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionController, type SessionMediaHooks } from "../../src/session/SessionController";
import { TIMEOUTS } from "../../src/core/config";
import { FakeDataLink, FakeMediaLink, FakeSignaling, FakeStream, FakeTrack } from "./fakes";

const ME = "psst-aaaa-aaaa-aaaa";
const BOB = "psst-bbbb-bbbb-bbbb";
const EVE = "psst-eeee-eeee-eeee";

function setup() {
  const signaling = new FakeSignaling(ME);
  const media = {
    createSilentStream: vi.fn(() => new FakeStream([new FakeTrack()]) as unknown as MediaStream),
    addSender: vi.fn(),
    removeSender: vi.fn(),
    addRemoteStream: vi.fn(),
    removeRemoteStream: vi.fn(),
    sessionEnded: vi.fn(),
  } satisfies SessionMediaHooks;
  const session = new SessionController({ signaling, media, getDisplayName: () => "Me" });
  return { signaling, media, session };
}

/** Delivers an incoming data link that opens and sends a join request. */
function incomingRequest(signaling: FakeSignaling, peerId: string, name = "Bob"): FakeDataLink {
  const link = new FakeDataLink(peerId);
  signaling.events.emit("incomingData", link);
  link.open();
  link.receive({ t: "join-request", v: 1, name });
  return link;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("SessionController authorization (PRIV-011)", () => {
  it("shows an incoming request without any media side effects", () => {
    const { signaling, media, session } = setup();
    incomingRequest(signaling, BOB);
    const s = session.snapshot();
    expect(s.incoming).toHaveLength(1);
    expect(s.phase).toBe("idle");
    expect(media.createSilentStream).not.toHaveBeenCalled();
    expect(media.addSender).not.toHaveBeenCalled();
  });

  it("closes an incoming call from a peer that was not accepted", () => {
    const { signaling, media } = setup();
    incomingRequest(signaling, BOB);
    const call = new FakeMediaLink(BOB);
    signaling.events.emit("incomingMedia", call);
    expect(call.closed).toBe(true);
    expect(call.answered).toBeNull();
    expect(media.addRemoteStream).not.toHaveBeenCalled();
  });

  it("closes an incoming call from a stranger even during an active session", () => {
    const { signaling, session } = setup();
    incomingRequest(signaling, BOB);
    session.acceptRequest(session.snapshot().incoming[0]!.id);
    const call = new FakeMediaLink(EVE);
    signaling.events.emit("incomingMedia", call);
    expect(call.closed).toBe(true);
  });

  it("answers only the accepted peer, once, and rejects video offers", () => {
    const { signaling, session, media } = setup();
    incomingRequest(signaling, BOB);
    session.acceptRequest(session.snapshot().incoming[0]!.id);
    expect(session.snapshot().phase).toBe("active");

    const video = new FakeMediaLink(BOB, true);
    signaling.events.emit("incomingMedia", video);
    expect(video.closed).toBe(true);
    expect(video.answered).toBeNull();

    const call = new FakeMediaLink(BOB);
    signaling.events.emit("incomingMedia", call);
    expect(call.answered).not.toBeNull();
    expect(media.addSender).toHaveBeenCalledTimes(1);
    // The synthetic silent track is stopped after the sender is handed to the mic controller.
    const silent = call.answered as unknown as FakeStream;
    expect(silent.getTracks()[0]?.readyState).toBe("ended");

    const second = new FakeMediaLink(BOB);
    signaling.events.emit("incomingMedia", second);
    expect(second.closed).toBe(true);
  });

  it("rejects a remote stream that carries video", () => {
    const { signaling, session, media } = setup();
    incomingRequest(signaling, BOB);
    session.acceptRequest(session.snapshot().incoming[0]!.id);
    const call = new FakeMediaLink(BOB);
    signaling.events.emit("incomingMedia", call);
    call.emitStream(new FakeStream([new FakeTrack("audio"), new FakeTrack("video")]));
    expect(media.addRemoteStream).not.toHaveBeenCalled();
    expect(call.closed).toBe(true);
  });

  it("closes links whose first message is not a valid join request", () => {
    const { signaling, session } = setup();
    const link = new FakeDataLink(BOB);
    signaling.events.emit("incomingData", link);
    link.open();
    link.receive({ t: "chat", v: 1, text: "let me in" });
    expect(link.closed).toBe(true);
    expect(session.snapshot().incoming).toHaveLength(0);
  });

  it("closes links from malformed peer ids and from self", () => {
    const { signaling } = setup();
    const bad = new FakeDataLink("not-a-uid");
    signaling.events.emit("incomingData", bad);
    expect(bad.closed).toBe(true);
    const self = new FakeDataLink(ME);
    signaling.events.emit("incomingData", self);
    expect(self.closed).toBe(true);
  });

  it("ignores duplicate requests from the same peer", () => {
    const { signaling, session } = setup();
    incomingRequest(signaling, BOB);
    const dup = incomingRequest(signaling, BOB);
    expect(dup.closed).toBe(true);
    expect(session.snapshot().incoming).toHaveLength(1);
  });

  it("closes handshakes that never send a request", () => {
    const { signaling } = setup();
    const link = new FakeDataLink(BOB);
    signaling.events.emit("incomingData", link);
    link.open();
    vi.advanceTimersByTime(TIMEOUTS.dataOpenMs + 1);
    expect(link.closed).toBe(true);
  });

  it("auto-rejects unanswered incoming requests", () => {
    const { signaling, session } = setup();
    const link = incomingRequest(signaling, BOB);
    vi.advanceTimersByTime(TIMEOUTS.incomingRequestMs + 1);
    expect(link.sent).toContainEqual({ t: "join-reject", v: 1, reason: "timeout" });
    expect(session.snapshot().incoming).toHaveLength(0);
  });

  it("rejects new requests as busy during an active session", () => {
    const { signaling, session } = setup();
    incomingRequest(signaling, BOB);
    session.acceptRequest(session.snapshot().incoming[0]!.id);
    const eve = incomingRequest(signaling, EVE, "Eve");
    expect(eve.sent).toContainEqual({ t: "join-reject", v: 1, reason: "busy" });
    expect(eve.closed).toBe(true);
  });
});

describe("SessionController outgoing requests", () => {
  it("validates target UID and prevents self-connection", () => {
    const { session, signaling } = setup();
    session.requestJoin("garbage");
    expect(session.snapshot().notice?.kind).toBe("error");
    session.requestJoin(ME);
    expect(session.snapshot().notice?.text).toMatch(/Kendinize/);
    expect(signaling.connections).toHaveLength(0);
  });

  it("sends a join request and places a call only after acceptance", () => {
    const { session, signaling, media } = setup();
    session.requestJoin(` ${BOB.toUpperCase()} `);
    const link = signaling.connections[0]!;
    expect(session.snapshot().phase).toBe("requesting");
    link.open();
    expect(link.sent).toEqual([{ t: "join-request", v: 1, name: "Me" }]);
    expect(signaling.calls).toHaveLength(0);
    expect(media.createSilentStream).not.toHaveBeenCalled();

    link.receive({ t: "join-accept", v: 1, name: "Bob" });
    expect(session.snapshot().phase).toBe("active");
    expect(signaling.calls).toHaveLength(1);
    expect(media.addSender).toHaveBeenCalledTimes(1);
  });

  it("returns to idle on rejection without media", () => {
    const { session, signaling } = setup();
    session.requestJoin(BOB);
    const link = signaling.connections[0]!;
    link.open();
    link.receive({ t: "join-reject", v: 1, reason: "declined" });
    expect(session.snapshot().phase).toBe("idle");
    expect(signaling.calls).toHaveLength(0);
    expect(link.closed).toBe(true);
  });

  it("times out if nobody answers", () => {
    const { session, signaling } = setup();
    session.requestJoin(BOB);
    signaling.connections[0]!.open();
    vi.advanceTimersByTime(TIMEOUTS.requestAnswerMs + 1);
    expect(session.snapshot().phase).toBe("idle");
    expect(signaling.connections[0]!.sent).toContainEqual({ t: "cancel", v: 1 });
  });

  it("fails fast when the UID is unavailable", () => {
    const { session, signaling } = setup();
    session.requestJoin(BOB);
    signaling.events.emit("error", { code: "peer-unavailable", message: "", fatal: false });
    expect(session.snapshot().phase).toBe("idle");
    expect(session.snapshot().notice?.kind).toBe("error");
  });
});

describe("SessionController chat and lifecycle", () => {
  function activeSession() {
    const ctx = setup();
    const link = incomingRequest(ctx.signaling, BOB);
    ctx.session.acceptRequest(ctx.session.snapshot().incoming[0]!.id);
    const call = new FakeMediaLink(BOB);
    ctx.signaling.events.emit("incomingMedia", call);
    return { ...ctx, link, call };
  }

  it("exchanges chat and drops excess messages (rate limit)", () => {
    const { session, link } = activeSession();
    expect(session.sendChat("  merhaba ")).toBe(true);
    expect(link.sent).toContainEqual({ t: "chat", v: 1, text: "merhaba" });
    for (let i = 0; i < 100; i++) link.receive({ t: "chat", v: 1, text: `spam ${i}` });
    const remote = session.snapshot().chat.filter((c) => !c.fromSelf);
    expect(remote.length).toBeLessThanOrEqual(20);
  });

  it("leave sends a leave message, tears everything down and resets audio", () => {
    const { session, link, call, media } = activeSession();
    session.sendChat("hi");
    session.leave();
    expect(link.sent).toContainEqual({ t: "leave", v: 1 });
    expect(link.closed).toBe(true);
    expect(call.closed).toBe(true);
    expect(media.removeSender).toHaveBeenCalled();
    expect(media.sessionEnded).toHaveBeenCalledTimes(1);
    const s = session.snapshot();
    expect(s.phase).toBe("idle");
    expect(s.chat).toHaveLength(0);
  });

  it("remote leave ends the 1:1 session safely", () => {
    const { session, link, media } = activeSession();
    link.receive({ t: "leave", v: 1 });
    expect(session.snapshot().phase).toBe("idle");
    expect(media.sessionEnded).toHaveBeenCalledTimes(1);
  });

  it("dispose is idempotent and leaves no session", () => {
    const { session, media } = activeSession();
    session.dispose();
    session.dispose();
    expect(media.sessionEnded).toHaveBeenCalledTimes(1);
  });

  it("marks media failed when the voice path does not come up in time", () => {
    const ctx = setup();
    incomingRequest(ctx.signaling, BOB);
    ctx.session.acceptRequest(ctx.session.snapshot().incoming[0]!.id);
    vi.advanceTimersByTime(TIMEOUTS.mediaSetupMs + 1);
    expect(ctx.session.snapshot().participants[0]?.media).toBe("failed");
  });
});
