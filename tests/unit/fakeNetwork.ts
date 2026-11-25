/**
 * In-memory mesh network for multi-peer SessionController tests.
 * Real SessionController + MicrophoneController + SpeakerController per node;
 * PeerJS / WebRTC replaced by paired fake links. Deliveries are queued and run by settle(),
 * messages are JSON round-tripped like the real "json" serializer.
 */
import { vi } from "vitest";
import { Emitter } from "../../src/core/emitter";
import { MicrophoneController } from "../../src/audio/MicrophoneController";
import { SpeakerController, type Player } from "../../src/audio/SpeakerController";
import type { Meter } from "../../src/audio/levels";
import { SessionController } from "../../src/session/SessionController";
import type { OfferVerdict } from "../../src/signaling/sdpPolicy";
import type { DataLink, MediaLink, Signaling, SignalingEvents, SignalingState } from "../../src/signaling/types";
import { FakePeerConnection, FakeSender, FakeStream, FakeTrack } from "./fakes";

type Task = () => void;

export class NetDataLink implements DataLink {
  /** Fake transport of this side; ICE state can be driven by tests (see FakeNetwork.vanish). */
  readonly pc = new FakePeerConnection([]);
  isOpen = false;
  closed = false;
  other!: NetDataLink;
  readonly sent: unknown[] = [];
  private openCbs: Array<() => void> = [];
  private dataCbs: Array<(d: unknown) => void> = [];
  private closeCbs: Array<() => void> = [];
  constructor(
    private readonly net: FakeNetwork,
    public readonly peerId: string,
  ) {}
  send(message: unknown): void {
    if (!this.isOpen || this.closed) return;
    this.sent.push(message);
    const copy = JSON.parse(JSON.stringify(message)) as unknown;
    const target = this.other;
    const deliver = (): void => {
      if (!target.closed) target.receive(copy);
    };
    // Test hook: hold selected message types on one direction to reorder delivery across channels.
    const t = (copy as { t?: string }).t ?? "";
    if (this.net.isHeld(this.other.peerId, this.peerId, t)) this.net.held.push(deliver);
    else this.net.enqueue(deliver);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.isOpen = false;
    for (const cb of this.closeCbs) cb();
    const other = this.other;
    this.net.enqueue(() => other.remoteClosed());
  }
  remoteClosed(): void {
    if (this.closed) return;
    this.closed = true;
    this.isOpen = false;
    for (const cb of this.closeCbs) cb();
  }
  onOpen(cb: () => void): void {
    this.openCbs.push(cb);
  }
  onData(cb: (d: unknown) => void): void {
    this.dataCbs.push(cb);
  }
  onClose(cb: () => void): void {
    this.closeCbs.push(cb);
  }
  onError(): void {}
  getPeerConnection(): RTCPeerConnection | null {
    return this.pc as unknown as RTCPeerConnection;
  }
  open(): void {
    if (this.closed) return;
    this.isOpen = true;
    for (const cb of this.openCbs) cb();
  }
  receive(data: unknown): void {
    for (const cb of [...this.dataCbs]) cb(data);
  }
  /** Test helper: inject raw data as if it came from the remote peer. */
  inject(data: unknown): void {
    this.receive(JSON.parse(JSON.stringify(data)) as unknown);
  }
}

export class NetMediaLink implements MediaLink {
  pc: FakePeerConnection | null = null;
  answered = false;
  closed = false;
  other!: NetMediaLink;
  private streamCbs: Array<(s: MediaStream) => void> = [];
  private closeCbs: Array<() => void> = [];
  constructor(
    private readonly net: FakeNetwork,
    public readonly peerId: string,
    public readonly offerVerdict: OfferVerdict,
  ) {}
  answer(stream: MediaStream): void {
    this.answered = true;
    this.pc = makePc(stream);
    this.net.mediaAnswered(this);
  }
  getPeerConnection(): RTCPeerConnection | null {
    return this.pc as unknown as RTCPeerConnection | null;
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const cb of this.closeCbs) cb();
    const other = this.other;
    this.net.enqueue(() => other.remoteClosed());
  }
  remoteClosed(): void {
    if (this.closed) return;
    this.closed = true;
    for (const cb of this.closeCbs) cb();
  }
  onStream(cb: (s: MediaStream) => void): void {
    this.streamCbs.push(cb);
  }
  onClose(cb: () => void): void {
    this.closeCbs.push(cb);
  }
  onError(): void {}
  emitStream(stream: FakeStream): void {
    for (const cb of this.streamCbs) cb(stream as unknown as MediaStream);
  }
}

function makePc(stream: MediaStream): FakePeerConnection {
  const track = (stream as unknown as FakeStream).getAudioTracks()[0] ?? null;
  return new FakePeerConnection([new FakeSender(track)]);
}

class NetSignaling implements Signaling {
  state: SignalingState = "online";
  readonly events = new Emitter<SignalingEvents>();
  constructor(
    private readonly net: FakeNetwork,
    public readonly uid: string,
  ) {}
  start(): void {}
  connect(peerId: string): DataLink {
    return this.net.connect(this.uid, peerId);
  }
  call(peerId: string, stream: MediaStream): MediaLink {
    return this.net.call(this.uid, peerId, stream);
  }
  on<K extends keyof SignalingEvents>(event: K, cb: (p: SignalingEvents[K]) => void): () => void {
    return this.events.on(event, cb);
  }
  destroy(): void {}
}

export interface NetNode {
  uid: string;
  name: string;
  signaling: NetSignaling;
  session: SessionController;
  mic: MicrophoneController;
  speaker: SpeakerController;
  /** getUserMedia calls and the tracks they produced. */
  gum: ReturnType<typeof vi.fn>;
  capturedTracks: FakeTrack[];
  pendingGum: Array<{ resolve: () => void; reject: (e: unknown) => void }>;
  players: Array<{ peerId: string; playing: boolean }>;
  sessionEnded: number;
  /** Outbound senders for which addSender was called (committed members only). */
  senders: Map<string, FakeSender>;
  remoteStreams: Set<string>;
}

export class FakeNetwork {
  readonly nodes = new Map<string, NetNode>();
  private queue: Task[] = [];
  /** Pairs "a|b" whose ICE never connects (simulates NAT failure). */
  readonly blockedMedia = new Set<string>();
  /** Per-callee verdict override for incoming offers. */
  readonly verdicts = new Map<string, OfferVerdict>();
  readonly dataLinks: NetDataLink[] = [];
  readonly mediaLinks: NetMediaLink[] = [];
  /** When true, getUserMedia stays pending until resolved by the test. */
  manualGum = false;
  /** Held deliveries (see hold()). */
  readonly held: Task[] = [];
  private readonly holds = new Set<string>();

  /** Hold messages of type `t` sent from `from` to `to` until release() (cross-channel reordering). */
  hold(from: string, to: string, t: string): void {
    this.holds.add(`${from}>${to}:${t}`);
  }

  isHeld(from: string, to: string, t: string): boolean {
    return this.holds.has(`${from}>${to}:${t}`);
  }

  release(): void {
    this.holds.clear();
    for (const task of this.held.splice(0)) this.enqueue(task);
  }

  enqueue(task: Task): void {
    this.queue.push(task);
  }

  settle(maxSteps = 20_000): void {
    let steps = 0;
    while (this.queue.length > 0) {
      if (++steps > maxSteps) throw new Error("network did not settle");
      const task = this.queue.shift();
      task?.();
    }
  }

  add(uid: string, name: string): NetNode {
    const signaling = new NetSignaling(this, uid);
    const capturedTracks: FakeTrack[] = [];
    const pendingGum: NetNode["pendingGum"] = [];
    const gum = vi.fn((_c: MediaStreamConstraints) => {
      const make = (): MediaStream => {
        const t = new FakeTrack("audio");
        capturedTracks.push(t);
        return new FakeStream([t]) as unknown as MediaStream;
      };
      if (!this.manualGum) return Promise.resolve(make());
      return new Promise<MediaStream>((resolve, reject) => {
        pendingGum.push({ resolve: () => resolve(make()), reject });
      });
    });
    const meter = (): Meter => ({ read: () => 0.5, dispose: () => undefined });
    const mic = new MicrophoneController({ getUserMedia: gum, createMeter: meter });
    const players: NetNode["players"] = [];
    let currentPeer = "";
    const speaker = new SpeakerController({
      createPlayer: (): Player => {
        const p = { peerId: currentPeer, playing: false };
        players.push(p);
        return {
          play: () => {
            p.playing = true;
            return Promise.resolve();
          },
          stop: () => {
            p.playing = false;
          },
        };
      },
      createMeter: meter,
    });
    const node = {} as NetNode;
    const session = new SessionController({
      signaling,
      getDisplayName: () => name,
      media: {
        createSilentStream: () => new FakeStream([new FakeTrack("audio")]) as unknown as MediaStream,
        addSender: (peerId, sender) => {
          node.senders.set(peerId, sender as unknown as FakeSender);
          mic.addSender(sender);
        },
        removeSender: (peerId, sender) => {
          node.senders.delete(peerId);
          mic.removeSender(sender);
        },
        addRemoteStream: (peerId, stream) => {
          node.remoteStreams.add(peerId);
          currentPeer = peerId;
          speaker.addRemote(peerId, stream);
        },
        removeRemoteStream: (peerId) => {
          node.remoteStreams.delete(peerId);
          speaker.removeRemote(peerId);
        },
        sessionEnded: () => {
          node.sessionEnded++;
          mic.disable();
          speaker.disable();
          speaker.clear();
        },
      },
    });
    Object.assign(node, {
      uid,
      name,
      signaling,
      session,
      mic,
      speaker,
      gum,
      capturedTracks,
      pendingGum,
      players,
      sessionEnded: 0,
      senders: new Map(),
      remoteStreams: new Set(),
    });
    this.nodes.set(uid, node);
    return node;
  }

  /**
   * The node disappears WITHOUT closing anything (crash / power loss): the others only see their
   * transports go ICE-"disconnected" and never get a close event.
   */
  vanish(uid: string): void {
    this.nodes.delete(uid);
    for (const l of this.dataLinks) if (l.peerId === uid && !l.closed) l.pc.setIce("disconnected");
    for (const m of this.mediaLinks) if (m.peerId === uid && !m.closed) m.pc?.setIce("disconnected");
  }

  /** Removes a node abruptly (tab killed): all its links close for the others. */
  kill(uid: string): void {
    const node = this.nodes.get(uid);
    if (!node) return;
    this.nodes.delete(uid);
    // Links held by the other peers whose remote end is the killed node.
    for (const l of this.dataLinks) if (l.peerId === uid && !l.closed) this.enqueue(() => l.remoteClosed());
    for (const m of this.mediaLinks) if (m.peerId === uid && !m.closed) this.enqueue(() => m.remoteClosed());
  }

  connect(from: string, to: string): DataLink {
    const a = new NetDataLink(this, to);
    const b = new NetDataLink(this, from);
    a.other = b;
    b.other = a;
    this.dataLinks.push(a, b);
    const target = this.nodes.get(to);
    if (!target) {
      this.enqueue(() =>
        this.nodes.get(from)?.signaling.events.emit("error", {
          code: "peer-unavailable",
          message: "",
          fatal: false,
          peerId: to,
        }),
      );
      return a;
    }
    this.enqueue(() => {
      if (!this.nodes.has(to)) return;
      target.signaling.events.emit("incomingData", b);
      this.enqueue(() => {
        a.open();
        b.open();
      });
    });
    return a;
  }

  call(from: string, to: string, stream: MediaStream): MediaLink {
    const caller = new NetMediaLink(this, to, "audio-only");
    caller.pc = makePc(stream);
    const callee = new NetMediaLink(this, from, this.verdicts.get(to) ?? "audio-only");
    caller.other = callee;
    callee.other = caller;
    this.mediaLinks.push(caller, callee);
    this.enqueue(() => this.nodes.get(to)?.signaling.events.emit("incomingMedia", callee));
    return caller;
  }

  mediaAnswered(callee: NetMediaLink): void {
    const caller = callee.other;
    const key = [caller.peerId, callee.peerId].sort().join("|");
    this.enqueue(() => {
      if (caller.closed || callee.closed) return;
      callee.emitStream(new FakeStream([new FakeTrack("audio")]));
      caller.emitStream(new FakeStream([new FakeTrack("audio")]));
      if (this.blockedMedia.has(key)) return;
      caller.pc?.setIce("connected");
      callee.pc?.setIce("connected");
    });
  }

  block(a: string, b: string): void {
    this.blockedMedia.add([a, b].sort().join("|"));
  }

  /** Open application data links between two nodes (excluding closed). */
  openLinksBetween(a: string, b: string): NetDataLink[] {
    return this.dataLinks.filter((l) => !l.closed && l.peerId === b && l.other.peerId === a);
  }

  openMediaBetween(a: string, b: string): NetMediaLink[] {
    return this.mediaLinks.filter((l) => !l.closed && l.peerId === b && l.other.peerId === a);
  }
}

// ------------------------------------------------------------------ helpers

export function uidOf(i: number): string {
  // Valid UID alphabet: digits 2-9 and letters without i/l/o.
  const ch = "abcdefghjkmnpq"[i] ?? "z";
  return `psst-${ch.repeat(4)}-${ch.repeat(4)}-${ch.repeat(4)}`;
}

export function incomingOf(node: NetNode) {
  return node.session.snapshot().incoming[0];
}

/** Every current member accepts the pending admission (in the given order). */
export function approveAll(net: FakeNetwork, nodes: NetNode[]): void {
  for (const n of nodes) {
    const req = incomingOf(n);
    if (req && req.myVote === "pending") n.session.acceptRequest(req.id);
    net.settle();
  }
}

/** Builds a committed session of the given nodes: nodes[0] is approached by each next node. */
export function formGroup(net: FakeNetwork, nodes: NetNode[]): void {
  for (let i = 1; i < nodes.length; i++) {
    const joiner = nodes[i]!;
    joiner.session.requestJoin(nodes[i - 1]!.uid); // join via the most recent member (not the initiator)
    net.settle();
    approveAll(net, nodes.slice(0, i));
    net.settle();
  }
}

export function memberIds(node: NetNode): string[] {
  return node.session
    .snapshot()
    .participants.map((p) => p.peerId)
    .sort();
}
