import { describe, expect, it, vi } from "vitest";
import { MIC_CONSTRAINTS, MicrophoneController } from "../../src/audio/MicrophoneController";
import { SpeakerController, type Player } from "../../src/audio/SpeakerController";
import type { Meter } from "../../src/audio/levels";
import { FakeSender, FakeStream, FakeTrack } from "./fakes";

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function fakeMeter(): Meter & { disposed: boolean } {
  return { disposed: false, read: () => 0.5, dispose() { this.disposed = true; } };
}

function setupMic() {
  const tracks: FakeTrack[] = [];
  const meters: Array<ReturnType<typeof fakeMeter>> = [];
  const pending: Array<ReturnType<typeof deferred<MediaStream>>> = [];
  const getUserMedia = vi.fn((_c: MediaStreamConstraints) => {
    const d = deferred<MediaStream>();
    pending.push(d);
    return d.promise;
  });
  const mic = new MicrophoneController({
    getUserMedia,
    createMeter: () => {
      const m = fakeMeter();
      meters.push(m);
      return m;
    },
  });
  const grant = (i = pending.length - 1) => {
    const t = new FakeTrack("audio");
    tracks.push(t);
    pending[i]?.resolve(new FakeStream([t]) as unknown as MediaStream);
    return t;
  };
  return { mic, getUserMedia, grant, pending, tracks, meters };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("MicrophoneController", () => {
  it("is off by default and never captures on construction (PRIV-001)", () => {
    const { mic, getUserMedia } = setupMic();
    mic.addSender(new FakeSender() as unknown as RTCRtpSender);
    expect(mic.snapshot().state).toBe("off");
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it("requests audio only (PRIV-008)", async () => {
    const { mic, getUserMedia, grant } = setupMic();
    const p = mic.enable();
    grant();
    await p;
    expect(getUserMedia).toHaveBeenCalledWith(MIC_CONSTRAINTS);
    expect(MIC_CONSTRAINTS.video).toBe(false);
  });

  it("attaches the live track on enable and really releases it on disable (PRIV-002)", async () => {
    const { mic, grant, meters } = setupMic();
    const sender = new FakeSender();
    mic.addSender(sender as unknown as RTCRtpSender);
    await flush();
    expect(sender.track).toBeNull();

    const p = mic.enable();
    const track = grant();
    await p;
    await flush();
    expect(mic.snapshot().state).toBe("on");
    expect(sender.track).toBe(track);
    expect(mic.readLevel()).toBe(0.5);

    mic.disable();
    await flush();
    expect(sender.track).toBeNull();
    expect(track.readyState).toBe("ended");
    expect(meters[0]?.disposed).toBe(true);
    expect(mic.readLevel()).toBe(0);
    expect(mic.snapshot().state).toBe("off");
  });

  it("re-enable starts a fresh capture and leaves no stale live track", async () => {
    const { mic, grant, tracks } = setupMic();
    for (let i = 0; i < 3; i++) {
      const p = mic.enable();
      grant();
      await p;
      mic.disable();
    }
    expect(tracks).toHaveLength(3);
    expect(tracks.every((t) => t.readyState === "ended")).toBe(true);
  });

  it("stops a capture that resolves after disable() (PRIV-006 race)", async () => {
    const { mic, grant } = setupMic();
    const p = mic.enable();
    mic.disable(); // user turned it off while the permission prompt was open
    const late = grant();
    await p;
    expect(late.readyState).toBe("ended");
    expect(mic.snapshot().state).toBe("off");
  });

  it("stops a capture that resolves after dispose()", async () => {
    const { mic, grant } = setupMic();
    const p = mic.enable();
    mic.dispose();
    const late = grant();
    await p;
    expect(late.readyState).toBe("ended");
  });

  it("new senders added while mic is on get the track; while off get null", async () => {
    const { mic, grant } = setupMic();
    const p = mic.enable();
    const track = grant();
    await p;
    const s1 = new FakeSender(new FakeTrack());
    mic.addSender(s1 as unknown as RTCRtpSender);
    await flush();
    expect(s1.track).toBe(track);
    mic.disable();
    const s2 = new FakeSender(new FakeTrack());
    mic.addSender(s2 as unknown as RTCRtpSender);
    await flush();
    expect(s2.track).toBeNull();
  });

  it("reports permission denial without throwing", async () => {
    const { mic, pending } = setupMic();
    const p = mic.enable();
    pending[0]?.reject(new DOMException("denied", "NotAllowedError"));
    await p;
    expect(mic.snapshot().state).toBe("error");
    expect(mic.snapshot().error).toMatch(/izni/);
  });

  it("falls back to off when the device track ends", async () => {
    const { mic, grant } = setupMic();
    const sender = new FakeSender();
    mic.addSender(sender as unknown as RTCRtpSender);
    const p = mic.enable();
    const track = grant();
    await p;
    track.fireEnded();
    await flush();
    expect(sender.track).toBeNull();
    expect(mic.snapshot().state).toBe("error");
  });
});

describe("SpeakerController", () => {
  function setupSpeaker() {
    const players: Array<Player & { playing: boolean; sinkId: string | null; volume: number }> = [];
    const meters: Array<ReturnType<typeof fakeMeter>> = [];
    const speaker = new SpeakerController({
      createPlayer: () => {
        const p = {
          playing: false,
          sinkId: null as string | null,
          volume: 1,
          setSinkId(id: string) {
            this.sinkId = id;
            return Promise.resolve();
          },
          setVolume(v: number) {
            this.volume = v;
          },
          play() {
            this.playing = true;
            return Promise.resolve();
          },
          stop() {
            this.playing = false;
          },
        };
        players.push(p);
        return p;
      },
      createMeter: () => {
        const m = fakeMeter();
        meters.push(m);
        return m;
      },
    });
    return { speaker, players, meters };
  }
  const stream = () => new FakeStream([new FakeTrack()]) as unknown as MediaStream;

  it("does not play remote audio until explicitly enabled (PRIV-003)", async () => {
    const { speaker, players } = setupSpeaker();
    speaker.addRemote("a", stream());
    expect(players).toHaveLength(0);
    expect(speaker.readMaxLevel()).toBe(0);
    speaker.enable();
    expect(players[0]?.playing).toBe(false); // not before routing is confirmed (AUD-006)
    await flush();
    expect(players[0]?.playing).toBe(true);
    expect(players[0]?.sinkId).toBe(""); // system default
    expect(speaker.readMaxLevel()).toBe(0.5);
  });

  it("disable stops all playback and analysers", () => {
    const { speaker, players, meters } = setupSpeaker();
    speaker.addRemote("a", stream());
    speaker.addRemote("b", stream());
    speaker.enable();
    speaker.disable();
    expect(players.every((p) => !p.playing)).toBe(true);
    expect(meters.every((m) => m.disposed)).toBe(true);
    expect(speaker.readLevel("a")).toBe(0);
  });

  it("a new participant does not turn the speaker on", () => {
    const { speaker, players } = setupSpeaker();
    speaker.enable();
    speaker.disable();
    speaker.addRemote("c", stream());
    expect(players.filter((p) => p.playing)).toHaveLength(0);
    expect(speaker.isEnabled()).toBe(false);
  });

  it("dispose is idempotent", () => {
    const { speaker } = setupSpeaker();
    speaker.addRemote("a", stream());
    speaker.enable();
    speaker.dispose();
    expect(() => speaker.dispose()).not.toThrow();
  });
});
