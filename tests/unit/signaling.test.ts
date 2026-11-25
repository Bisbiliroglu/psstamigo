/** REC-001…004: bounded signaling reconnect with a fake PeerJS Peer and a fake clock. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SIGNALING_RECONNECT } from "../../src/core/config";
import { PeerJsSignaling, type PeerLike } from "../../src/signaling/PeerJsSignaling";

class FakePeer {
  disconnected = false;
  destroyed = false;
  reconnects = 0;
  readonly handlers = new Map<string, Array<(...a: unknown[]) => void>>();
  constructor(public readonly id: string) {}
  on(event: string, cb: (...a: unknown[]) => void): this {
    const list = this.handlers.get(event) ?? [];
    list.push(cb);
    this.handlers.set(event, list);
    return this;
  }
  emit(event: string, ...args: unknown[]): void {
    for (const cb of this.handlers.get(event) ?? []) cb(...args);
  }
  reconnect(): void {
    this.disconnected = false;
    this.reconnects++;
  }
  disconnect(): void {
    if (this.disconnected) return;
    this.disconnected = true;
    this.emit("disconnected");
  }
  destroy(): void {
    this.destroyed = true;
  }
  connect(): never {
    throw new Error("not used");
  }
  call(): never {
    throw new Error("not used");
  }
  /** Server connection lost (what PeerJS does on socket close). */
  lose(): void {
    this.disconnected = true;
    this.emit("disconnected");
  }
}

let peers: FakePeer[];
let sig: PeerJsSignaling;
let random: number;

beforeEach(() => {
  vi.useFakeTimers();
  peers = [];
  random = 0.5; // no jitter
  sig = new PeerJsSignaling(
    (id) => {
      const p = new FakePeer(id);
      peers.push(p);
      return p as unknown as PeerLike;
    },
    () => random,
  );
  sig.start();
  peers[0]!.emit("open", peers[0]!.id);
});
afterEach(() => {
  sig.destroy();
  vi.clearAllTimers();
  vi.useRealTimers();
});

const peer = (): FakePeer => peers.at(-1)!;

describe("signaling-only interruption", () => {
  it("keeps the Peer (and thus P2P links) and reconnects with the same UID", () => {
    const uid = sig.uid;
    peer().lose();
    expect(sig.state).toBe("reconnecting");
    expect(peer().destroyed).toBe(false); // P2P links untouched (REC-001)
    vi.advanceTimersByTime(SIGNALING_RECONNECT.delaysMs[0]!);
    expect(peer().reconnects).toBe(1);
    expect(sig.reconnectAttempt).toBe(1);
    peer().emit("open", uid);
    expect(sig.state).toBe("online");
    expect(sig.uid).toBe(uid); // REC-003
    expect(peers).toHaveLength(1); // no new Peer, no new UID
    expect(vi.getTimerCount()).toBe(0);
  });

  it("runs a single bounded loop and gives up after the last attempt", () => {
    peer().lose();
    peer().lose(); // duplicate signal must not start a second loop
    expect(vi.getTimerCount()).toBe(1);
    for (const delay of SIGNALING_RECONNECT.delaysMs) {
      vi.advanceTimersByTime(delay);
      peer().lose(); // this attempt failed
    }
    expect(peer().reconnects).toBe(SIGNALING_RECONNECT.delaysMs.length);
    expect(sig.state).toBe("unavailable");
    expect(vi.getTimerCount()).toBe(0); // no infinite loop
    vi.advanceTimersByTime(10 * 60_000);
    expect(peer().reconnects).toBe(SIGNALING_RECONNECT.delaysMs.length);
  });

  it("abandons a hanging attempt and schedules the next one", () => {
    peer().lose();
    vi.advanceTimersByTime(SIGNALING_RECONNECT.delaysMs[0]!);
    expect(peer().reconnects).toBe(1);
    vi.advanceTimersByTime(SIGNALING_RECONNECT.attemptTimeoutMs);
    expect(peer().disconnected).toBe(true);
    vi.advanceTimersByTime(SIGNALING_RECONNECT.delaysMs[1]!);
    expect(peer().reconnects).toBe(2);
  });

  it("applies ±25 % jitter to the backoff", () => {
    random = 0; // -25 %
    peer().lose();
    vi.advanceTimersByTime(SIGNALING_RECONNECT.delaysMs[0]! * 0.75 - 1);
    expect(peer().reconnects).toBe(0);
    vi.advanceTimersByTime(1);
    expect(peer().reconnects).toBe(1);
  });

  it("manual retry resets the loop and tries immediately", () => {
    peer().lose();
    for (const delay of SIGNALING_RECONNECT.delaysMs) {
      vi.advanceTimersByTime(delay);
      peer().lose();
    }
    expect(sig.state).toBe("unavailable");
    sig.retryNow();
    expect(peer().reconnects).toBe(SIGNALING_RECONNECT.delaysMs.length + 1);
    expect(sig.state).toBe("reconnecting");
    peer().emit("open", peer().id);
    expect(sig.state).toBe("online");
  });

  it("destroy (leave page) cancels the loop", () => {
    peer().lose();
    sig.destroy();
    vi.advanceTimersByTime(10 * 60_000);
    expect(peer().reconnects).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("UID lost while away (REC-003)", () => {
  it("stops retrying, reports it, and only renews the UID on request", () => {
    const oldUid = sig.uid;
    peer().lose();
    vi.advanceTimersByTime(SIGNALING_RECONNECT.delaysMs[0]!);
    peer().emit("error", { type: "unavailable-id", message: "taken" });
    expect(sig.state).toBe("unavailable");
    expect(sig.uidLost).toBe(true);
    vi.advanceTimersByTime(10 * 60_000);
    expect(peers).toHaveLength(1); // never switches UID by itself
    sig.retryNow(); // retry cannot reclaim a taken UID
    expect(peers).toHaveLength(1);

    sig.renewIdentity();
    expect(peers).toHaveLength(2);
    expect(peers[0]!.destroyed).toBe(true);
    peer().emit("open", peer().id);
    expect(sig.state).toBe("online");
    expect(sig.uid).not.toBe(oldUid);
    expect(sig.uidLost).toBe(false);
  });
});

describe("first registration failure (REC-004)", () => {
  it("reports failure and lets the user retry", () => {
    const s2 = new PeerJsSignaling((id) => {
      const p = new FakePeer(id);
      peers.push(p);
      return p as unknown as PeerLike;
    });
    s2.start();
    peer().emit("error", { type: "network", message: "down" });
    peer().emit("error", { type: "server-error", message: "down" });
    expect(s2.state).toBe("failed");
    const before = peers.length;
    s2.retryNow();
    expect(peers.length).toBe(before + 1);
    expect(s2.state).toBe("connecting");
    s2.destroy();
  });
});
