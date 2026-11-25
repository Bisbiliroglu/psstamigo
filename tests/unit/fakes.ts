/** Minimal fakes for WebRTC / media objects in a Node test environment. */
import type { DataLink, MediaLink, Signaling, SignalingEvents, SignalingState } from "../../src/signaling/types";
import { Emitter } from "../../src/core/emitter";

export class FakeTrack {
  readyState: "live" | "ended" = "live";
  enabled = true;
  private listeners = new Set<() => void>();
  constructor(public readonly kind: "audio" | "video" = "audio") {}
  stop(): void {
    this.readyState = "ended";
  }
  addEventListener(_type: "ended", cb: () => void): void {
    this.listeners.add(cb);
  }
  removeEventListener(_type: "ended", cb: () => void): void {
    this.listeners.delete(cb);
  }
  /** Simulates the device being unplugged. */
  fireEnded(): void {
    this.readyState = "ended";
    for (const l of this.listeners) l();
  }
}

export class FakeStream {
  constructor(private readonly tracks: FakeTrack[]) {}
  getTracks(): FakeTrack[] {
    return this.tracks;
  }
  getAudioTracks(): FakeTrack[] {
    return this.tracks.filter((t) => t.kind === "audio");
  }
  getVideoTracks(): FakeTrack[] {
    return this.tracks.filter((t) => t.kind === "video");
  }
}

export class FakeSender {
  track: FakeTrack | null;
  readonly history: Array<FakeTrack | null> = [];
  constructor(initial: FakeTrack | null = null) {
    this.track = initial;
  }
  replaceTrack(track: FakeTrack | null): Promise<void> {
    this.track = track;
    this.history.push(track);
    return Promise.resolve();
  }
}

export class FakePeerConnection {
  iceConnectionState = "new";
  connectionState = "new";
  private listeners = new Map<string, Set<() => void>>();
  constructor(public readonly senders: FakeSender[]) {}
  getSenders(): FakeSender[] {
    return this.senders;
  }
  addEventListener(type: string, cb: () => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)?.add(cb);
  }
  removeEventListener(type: string, cb: () => void): void {
    this.listeners.get(type)?.delete(cb);
  }
  setIce(state: string): void {
    this.iceConnectionState = state;
    this.connectionState = state === "connected" ? "connected" : state;
    for (const cb of this.listeners.get("iceconnectionstatechange") ?? []) cb();
  }
}

export class FakeDataLink implements DataLink {
  isOpen = false;
  closed = false;
  readonly sent: unknown[] = [];
  private openCbs: Array<() => void> = [];
  private dataCbs: Array<(d: unknown) => void> = [];
  private closeCbs: Array<() => void> = [];
  constructor(public readonly peerId: string) {}
  send(message: unknown): void {
    if (this.isOpen && !this.closed) this.sent.push(message);
  }
  close(): void {
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
  // --- test helpers
  open(): void {
    this.isOpen = true;
    for (const cb of this.openCbs) cb();
  }
  receive(data: unknown): void {
    for (const cb of [...this.dataCbs]) cb(data);
  }
}

export class FakeMediaLink implements MediaLink {
  answered: MediaStream | null = null;
  closed = false;
  pc: FakePeerConnection | null = null;
  private streamCbs: Array<(s: MediaStream) => void> = [];
  private closeCbs: Array<() => void> = [];
  constructor(
    public readonly peerId: string,
    public readonly offerHasVideo = false,
    outgoingStream: MediaStream | null = null,
  ) {
    if (outgoingStream) this.pc = makePc(outgoingStream);
  }
  answer(stream: MediaStream): void {
    this.answered = stream;
    this.pc = makePc(stream);
  }
  getPeerConnection(): RTCPeerConnection | null {
    return this.pc as unknown as RTCPeerConnection | null;
  }
  close(): void {
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

export class FakeSignaling implements Signaling {
  uid: string | null;
  state: SignalingState = "online";
  readonly events = new Emitter<SignalingEvents>();
  readonly connections: FakeDataLink[] = [];
  readonly calls: FakeMediaLink[] = [];
  constructor(uid: string) {
    this.uid = uid;
  }
  start(): void {}
  connect(peerId: string): DataLink {
    const link = new FakeDataLink(peerId);
    this.connections.push(link);
    return link;
  }
  call(peerId: string, stream: MediaStream): MediaLink {
    const link = new FakeMediaLink(peerId, false, stream);
    this.calls.push(link);
    return link;
  }
  on<K extends keyof SignalingEvents>(event: K, cb: (p: SignalingEvents[K]) => void): () => void {
    return this.events.on(event, cb);
  }
  destroy(): void {}
}
