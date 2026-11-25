/** PA-009 unit tests (mocked media APIs). Physical device routing is a manual test. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AudioDevices, deviceLabel } from "../../src/audio/AudioDevices";
import { AudioDiagnostics, MIC_TEST_MS, type TonePlayer } from "../../src/audio/AudioDiagnostics";
import { AudioPreferences, parsePrefs, PREFERENCES_KEY } from "../../src/audio/AudioPreferences";
import { DEFAULT_PROCESSING, MicrophoneController } from "../../src/audio/MicrophoneController";
import { SpeakerController, type Player } from "../../src/audio/SpeakerController";
import type { Meter } from "../../src/audio/levels";
import { SingleTab } from "../../src/app/SingleTab";
import { FakeSender, FakeStream, FakeTrack } from "./fakes";

const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
const meter = (): Meter => ({ read: () => 0.5, dispose: () => undefined });

/** Track that reports a deviceId and supports applyConstraints. */
class DevTrack extends FakeTrack {
  settings: MediaTrackSettings;
  constructor(deviceId: string, public failApply = false) {
    super("audio");
    this.settings = { deviceId, ...DEFAULT_PROCESSING };
  }
  getSettings(): MediaTrackSettings {
    return this.settings;
  }
  applyConstraints(c: MediaTrackConstraints): Promise<void> {
    if (this.failApply) return Promise.reject(new DOMException("no", "OverconstrainedError"));
    // Simulate a browser that cannot turn AGC off.
    this.settings = { ...this.settings, echoCancellation: c.echoCancellation as boolean, noiseSuppression: c.noiseSuppression as boolean };
    return Promise.resolve();
  }
}

type Pending = { constraints: MediaStreamConstraints; resolve: (deviceId?: string) => DevTrack; reject: (e: unknown) => void };

function micSetup() {
  const pending: Pending[] = [];
  const tracks: DevTrack[] = [];
  const gum = vi.fn((c: MediaStreamConstraints) =>
    new Promise<MediaStream>((res, rej) => {
      const wanted = ((c.audio as MediaTrackConstraints).deviceId as { exact?: string } | undefined)?.exact ?? "default-mic";
      pending.push({
        constraints: c,
        resolve: (deviceId = wanted) => {
          const t = new DevTrack(deviceId);
          tracks.push(t);
          res(new FakeStream([t]) as unknown as MediaStream);
          return t;
        },
        reject: rej,
      });
    }),
  );
  const mic = new MicrophoneController({ getUserMedia: gum, createMeter: meter });
  return { mic, gum, pending, tracks };
}

describe("AudioDevices (AUD-001/002/009)", () => {
  it("lists only audio devices, hides virtual defaults, never invents names", async () => {
    let onChange: (() => void) | null = null;
    const list = [
      { deviceId: "default", kind: "audioinput", label: "" },
      { deviceId: "mic-1", kind: "audioinput", label: "" },
      { deviceId: "cam-1", kind: "videoinput", label: "Webcam" },
      { deviceId: "out-1", kind: "audiooutput", label: "" },
    ] as MediaDeviceInfo[];
    const d = new AudioDevices({
      enumerate: () => Promise.resolve(list),
      onDeviceChange: (cb) => {
        onChange = cb;
        return () => undefined;
      },
      outputSelectable: true,
    });
    d.start();
    await flush();
    const s = d.snapshot();
    expect(s.inputs.map((x) => x.id)).toEqual(["mic-1"]);
    expect(s.outputs.map((x) => x.id)).toEqual(["out-1"]);
    expect(JSON.stringify(s)).not.toContain("cam-1"); // video never stored
    expect(s.labelsAvailable).toBe(false);
    expect(deviceLabel(s.inputs[0]!, 0)).toMatch(/Mikrofon 1/);
    list[1] = { deviceId: "mic-1", kind: "audioinput", label: "USB Mic" } as MediaDeviceInfo;
    onChange!();
    await flush();
    expect(d.snapshot().inputs[0]?.label).toBe("USB Mic");
    expect(d.snapshot().changeEvents).toBe(true);
  });

  it("ignores a stale enumeration result", async () => {
    const resolvers: Array<(l: MediaDeviceInfo[]) => void> = [];
    const d = new AudioDevices({
      enumerate: () => new Promise((r) => resolvers.push(r)),
      onDeviceChange: () => null,
      outputSelectable: false,
    });
    const first = d.refresh();
    const second = d.refresh();
    resolvers[1]!([{ deviceId: "new", kind: "audioinput", label: "New" } as MediaDeviceInfo]);
    resolvers[0]!([{ deviceId: "old", kind: "audioinput", label: "Old" } as MediaDeviceInfo]);
    await Promise.all([first, second]);
    expect(d.snapshot().inputs.map((x) => x.id)).toEqual(["new"]);
  });
});

describe("microphone selection and switching (AUD-003…005, AUD-010)", () => {
  it("selecting while muted never captures; enabling later uses the exact device", async () => {
    const { mic, gum, pending } = micSetup();
    await mic.selectDevice("usb-mic");
    expect(gum).not.toHaveBeenCalled();
    const p = mic.enable();
    expect(((pending[0]!.constraints.audio as MediaTrackConstraints).deviceId as { exact: string }).exact).toBe("usb-mic");
    expect(pending[0]!.constraints.video).toBe(false);
    pending[0]!.resolve();
    await p;
    expect(mic.snapshot().activeDeviceId).toBe("usb-mic");
  });

  it("active switch stops the old capture BEFORE opening the new one; senders follow; single capture", async () => {
    const { mic, pending, tracks } = micSetup();
    const sender = new FakeSender();
    mic.addSender(sender as unknown as RTCRtpSender);
    const p1 = mic.enable();
    pending[0]!.resolve();
    await p1;
    await flush();
    expect(sender.track).toBe(tracks[0]);
    const p2 = mic.selectDevice("headset-mic");
    expect(tracks[0]!.readyState).toBe("ended"); // old capture gone before the new request resolves
    await flush();
    expect(sender.track).toBeNull();
    pending[1]!.resolve();
    await p2;
    await flush();
    expect(sender.track).toBe(tracks[1]);
    expect(tracks.filter((t) => t.readyState === "live")).toHaveLength(1);
    expect(mic.snapshot().activeDeviceId).toBe("headset-mic");
  });

  it("a failed switch leaves the mic OFF and never opens another device", async () => {
    const { mic, gum, pending } = micSetup();
    const p1 = mic.enable();
    pending[0]!.resolve();
    await p1;
    const p2 = mic.selectDevice("gone-mic");
    pending[1]!.reject(new DOMException("x", "OverconstrainedError"));
    await p2;
    expect(mic.snapshot().state).toBe("error");
    expect(mic.snapshot().error).toMatch(/Başka bir mikrofon açılmadı/);
    expect(gum).toHaveBeenCalledTimes(2); // no retry with the old/default device
  });

  it("rejects a capture that came from a different device than selected", async () => {
    const { mic, pending, tracks } = micSetup();
    await mic.selectDevice("usb-mic");
    const p = mic.enable();
    pending[0]!.resolve("laptop-mic");
    await p;
    expect(mic.snapshot().state).toBe("error");
    expect(tracks[0]!.readyState).toBe("ended");
  });

  it("rapid selection changes: only the last capture survives", async () => {
    const { mic, pending, tracks } = micSetup();
    const p0 = mic.enable();
    pending[0]!.resolve();
    await p0;
    const a = mic.selectDevice("a");
    const b = mic.selectDevice("b");
    pending[1]!.resolve(); // late result for "a"
    pending[2]!.resolve();
    await Promise.all([a, b]);
    expect(tracks.filter((t) => t.readyState === "live").map((t) => t.settings.deviceId)).toEqual(["b"]);
  });

  it("disabling while the new device permission is pending stops the late capture", async () => {
    const { mic, pending, tracks } = micSetup();
    await mic.selectDevice("usb-mic");
    const p = mic.enable();
    mic.disable();
    pending[0]!.resolve();
    await p;
    expect(tracks[0]!.readyState).toBe("ended");
    expect(mic.snapshot().state).toBe("off");
  });

  it("a participant joining during switching gets the new track; one leaving gets nothing", async () => {
    const { mic, pending, tracks } = micSetup();
    const leaving = new FakeSender();
    mic.addSender(leaving as unknown as RTCRtpSender);
    const p0 = mic.enable();
    pending[0]!.resolve();
    await p0;
    const sw = mic.selectDevice("new");
    const joining = new FakeSender(new FakeTrack());
    mic.addSender(joining as unknown as RTCRtpSender);
    mic.removeSender(leaving as unknown as RTCRtpSender);
    pending[1]!.resolve();
    await sw;
    await flush();
    expect(joining.track).toBe(tracks[1]);
    expect(leaving.track).toBeNull();
  });

  it("unplugged device: capture stops, no fallback, enable refused until it is back; reconnect keeps it off", async () => {
    const { mic, gum, pending, tracks } = micSetup();
    await mic.selectDevice("usb-mic");
    const p = mic.enable();
    pending[0]!.resolve();
    await p;
    tracks[0]!.fireEnded();
    expect(mic.snapshot().state).toBe("error");
    expect(tracks[0]!.readyState).toBe("ended");
    await mic.enable();
    expect(gum).toHaveBeenCalledTimes(1);
    mic.markDeviceAvailable();
    expect(mic.snapshot().state).not.toBe("on");
    expect(gum).toHaveBeenCalledTimes(1);
  });

  it("processing: muted changes never capture; live changes report requested vs applied", async () => {
    const { mic, gum, pending } = micSetup();
    await mic.setProcessing("noiseSuppression", false);
    expect(gum).not.toHaveBeenCalled();
    expect(pending).toHaveLength(0);
    expect(mic.snapshot().requested.noiseSuppression).toBe(false);
    const p = mic.enable();
    expect((pending[0]!.constraints.audio as MediaTrackConstraints).noiseSuppression).toBe(false);
    pending[0]!.resolve();
    await p;
    await mic.setProcessing("autoGainControl", false); // fake browser cannot turn AGC off
    const s = mic.snapshot();
    expect(s.requested.autoGainControl).toBe(false);
    expect(s.applied?.autoGainControl).toBe(true);
  });
});

describe("speaker routing and volumes (AUD-006…008, AUD-011, AUD-014…016)", () => {
  type FP = Player & { playing: boolean; sinkId: string | null; volume: number; rejectSink: boolean; pendingSink: (() => void) | null };
  function speakerSetup(opts: { deferSink?: boolean } = {}) {
    const players: FP[] = [];
    let failNext = false;
    const speaker = new SpeakerController({
      createPlayer: () => {
        const p: FP = {
          playing: false,
          sinkId: null,
          volume: 1,
          rejectSink: failNext,
          pendingSink: null,
          setSinkId(id) {
            if (this.rejectSink) return Promise.reject(new DOMException("x", "NotFoundError"));
            if (opts.deferSink) {
              return new Promise<void>((r) => {
                this.pendingSink = () => {
                  this.sinkId = id;
                  r();
                };
              });
            }
            this.sinkId = id;
            return Promise.resolve();
          },
          setVolume(v) {
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
      createMeter: meter,
    });
    return { speaker, players, failNextSink: () => (failNext = true) };
  }
  const stream = () => new FakeStream([new FakeTrack()]) as unknown as MediaStream;
  const playing = (ps: FP[]) => ps.filter((p) => p.playing);

  it("selecting while off does not play; enabling routes every player before play", async () => {
    const { speaker, players } = speakerSetup();
    speaker.addRemote("a", stream());
    speaker.addRemote("b", stream());
    speaker.selectOutput("headset");
    await flush();
    expect(players).toHaveLength(0);
    speaker.enable();
    await flush();
    expect(playing(players).map((p) => p.sinkId)).toEqual(["headset", "headset"]);
    expect(speaker.snapshot().routed).toBe(true);
  });

  it("switching output while on re-routes all; a new participant inherits the device", async () => {
    const { speaker, players } = speakerSetup();
    speaker.addRemote("a", stream());
    speaker.enable();
    await flush();
    speaker.selectOutput("monitor");
    speaker.addRemote("b", stream());
    await flush();
    expect(playing(players).map((p) => p.sinkId)).toEqual(["monitor", "monitor"]);
  });

  it("any routing failure stops ALL playback and turns the speaker off (no partial/fallback)", async () => {
    const { speaker, players, failNextSink } = speakerSetup();
    speaker.addRemote("a", stream());
    speaker.enable();
    await flush();
    failNextSink();
    speaker.addRemote("b", stream());
    await flush();
    expect(playing(players)).toHaveLength(0);
    expect(speaker.isEnabled()).toBe(false);
    expect(speaker.snapshot().error).toMatch(/başka bir cihazdan çalınmadı/);
  });

  it("disabling while setSinkId is pending never starts playback", async () => {
    const { speaker, players } = speakerSetup({ deferSink: true });
    speaker.addRemote("a", stream());
    speaker.enable();
    speaker.disable();
    players[0]!.pendingSink!();
    await flush();
    expect(playing(players)).toHaveLength(0);
  });

  it("removed output: playback stops, enable refused, reconnect keeps it off", async () => {
    const { speaker, players } = speakerSetup();
    speaker.selectOutput("bt-headset");
    speaker.addRemote("a", stream());
    speaker.enable();
    await flush();
    speaker.markOutputUnavailable();
    expect(playing(players)).toHaveLength(0);
    speaker.enable();
    await flush();
    expect(speaker.isEnabled()).toBe(false);
    speaker.markOutputAvailable();
    expect(speaker.isEnabled()).toBe(false);
  });

  it("volume = master × participant; mute keeps the volume; speaker off overrides everything", async () => {
    const { speaker, players } = speakerSetup();
    speaker.addRemote("a", stream());
    speaker.addRemote("b", stream());
    speaker.setMasterVolume(0.5);
    speaker.setParticipantVolume("a", 0.4);
    expect(players).toHaveLength(0); // still off: no playback from volume changes
    speaker.enable();
    await flush();
    expect(players.map((p) => p.volume)).toEqual([0.2, 0.5]);
    speaker.setParticipantMuted("a", true);
    expect(players[0]!.volume).toBe(0);
    expect(players[1]!.volume).toBe(0.5);
    expect(speaker.readLevel("a")).toBe(0);
    speaker.setParticipantMuted("a", false);
    expect(players[0]!.volume).toBe(0.2);
    speaker.setParticipantVolume("a", 7); // clamped to 100 %
    expect(speaker.getParticipantAudio("a").volume).toBe(1);
  });
});

describe("local diagnostics (AUD-012/013)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function diagSetup(tone: Partial<TonePlayer> = {}) {
    const tracks: DevTrack[] = [];
    const gum = vi.fn((c: MediaStreamConstraints) => {
      const wanted = ((c.audio as MediaTrackConstraints).deviceId as { exact?: string } | undefined)?.exact ?? "default-mic";
      const t = new DevTrack(wanted);
      tracks.push(t);
      return Promise.resolve(new FakeStream([t]) as unknown as MediaStream);
    });
    const played: string[] = [];
    const d = new AudioDiagnostics({
      getUserMedia: gum,
      createMeter: meter,
      createTonePlayer: () => ({
        play: tone.play ?? ((sink) => {
          played.push(sink);
          return Promise.resolve();
        }),
        stop: tone.stop ?? (() => undefined),
      }),
    });
    return { d, gum, tracks, played };
  }

  it("mic test uses the selected device, has a level, and stops after 15 s", async () => {
    const { d, tracks } = diagSetup();
    await d.startMicTest("usb-mic", DEFAULT_PROCESSING);
    expect(d.snapshot().micTest).toBe("running");
    expect(tracks[0]!.settings.deviceId).toBe("usb-mic");
    expect(d.readMicTestLevel()).toBe(0.5);
    vi.advanceTimersByTime(MIC_TEST_MS);
    expect(tracks[0]!.readyState).toBe("ended");
    expect(d.snapshot().micTest).toBe("idle");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a stale test capture is stopped; dispose (page close) ends the test", async () => {
    const { d, tracks } = diagSetup();
    const p = d.startMicTest(null, DEFAULT_PROCESSING);
    d.stopMicTest();
    await p;
    expect(tracks[0]!.readyState).toBe("ended");
    await d.startMicTest(null, DEFAULT_PROCESSING);
    d.dispose();
    expect(tracks[1]!.readyState).toBe("ended");
  });

  it("speaker test plays on the selected output; a routing failure plays nothing", async () => {
    const ok = diagSetup();
    const run = ok.d.playTestTone("headset");
    await flush();
    vi.advanceTimersByTime(2_000);
    await run;
    expect(ok.played).toEqual(["headset"]);
    const bad = diagSetup({ play: () => Promise.reject(new Error("routing")) });
    await bad.d.playTestTone("gone");
    expect(bad.d.snapshot().speakerTest).toBe("error");
    expect(bad.played).toHaveLength(0);
  });
});

describe("opt-in audio preferences (D-034)", () => {
  function memStorage() {
    const m = new Map<string, string>();
    return {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
      removeItem: (k: string) => void m.delete(k),
      dump: () => [...m.entries()],
    };
  }

  it("stores only the approved minimal fields, and clears completely", () => {
    const st = memStorage();
    const prefs = new AudioPreferences(() => st);
    expect(prefs.isRemembering()).toBe(false);
    prefs.save({ inputId: "usb-mic", outputId: null, masterVolume: 0.8, processing: { ...DEFAULT_PROCESSING } });
    const [[key, value]] = st.dump() as [[string, string]];
    expect(key).toBe(PREFERENCES_KEY);
    expect(Object.keys(JSON.parse(value)).sort()).toEqual(["inputId", "masterVolume", "outputId", "processing"]);
    expect(prefs.load()?.inputId).toBe("usb-mic");
    prefs.clear();
    expect(st.dump()).toHaveLength(0);
  });

  it.each([
    "not json",
    JSON.stringify({ inputId: "a", outputId: null, masterVolume: 2, processing: DEFAULT_PROCESSING }),
    JSON.stringify({ inputId: "a", outputId: null, masterVolume: 1, processing: DEFAULT_PROCESSING, uid: "psst-x" }),
    JSON.stringify({ inputId: 5, outputId: null, masterVolume: 1, processing: DEFAULT_PROCESSING }),
  ])("ignores corrupt or unexpected stored data %#", (raw) => {
    expect(parsePrefs(raw)).toBeNull();
  });

  it("works without storage (blocked): nothing is remembered, nothing throws", () => {
    const prefs = new AudioPreferences(() => {
      throw new Error("blocked");
    });
    expect(prefs.available).toBe(false);
    expect(prefs.load()).toBeNull();
  });
});

describe("single active tab (D-035)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /** Minimal in-memory Web Locks + BroadcastChannel shared by "tabs". */
  function env() {
    let holder: { release: () => void; reject: (e: unknown) => void } | null = null;
    const waiting: Array<() => void> = [];
    const listeners = new Set<(e: { data: unknown }) => void>();
    const locks = {
      request(_n: string, opts: { ifAvailable?: boolean; steal?: boolean }, cb: (l: unknown) => Promise<void> | void) {
        return new Promise<unknown>((resolve, reject) => {
          const grant = (): void => {
            const r = cb({});
            const done = (): void => {
              holder = null;
              resolve(undefined);
              waiting.shift()?.();
            };
            holder = { release: done, reject };
            if (r && typeof (r as Promise<void>).then === "function") void (r as Promise<void>).then(done);
            else done();
          };
          if (!holder) return grant();
          if (opts.ifAvailable) {
            void Promise.resolve(cb(null)).then(() => resolve(undefined));
            return;
          }
          if (opts.steal) {
            const old = holder;
            holder = null;
            old.reject(new DOMException("stolen", "AbortError"));
            return grant();
          }
          waiting.push(grant);
        });
      },
    };
    const channel = () =>
      ({
        set onmessage(fn: (e: { data: unknown }) => void) {
          listeners.add(fn);
        },
        postMessage(data: unknown) {
          for (const l of [...listeners]) l({ data });
        },
        close() {},
      }) as unknown as BroadcastChannel;
    return { locks, channel };
  }

  it("first tab starts; second waits and takes over only on request; first shuts down", async () => {
    const e = env();
    const log: string[] = [];
    const first = new SingleTab({ acquired: () => log.push("1:start"), busy: () => log.push("1:busy"), replaced: () => log.push("1:replaced") }, e.locks, e.channel);
    first.start();
    await flush();
    let takeOver: (() => void) | null = null;
    const second = new SingleTab(
      { acquired: () => log.push("2:start"), busy: (t) => ((takeOver = t), log.push("2:busy")), replaced: () => log.push("2:replaced") },
      e.locks,
      e.channel,
    );
    second.start();
    await flush();
    expect(log).toEqual(["1:start", "2:busy"]); // no hidden second participant
    takeOver!();
    await flush();
    expect(log).toEqual(["1:start", "2:busy", "1:replaced", "2:start"]);
  });

  it("a frozen first tab is taken over after the wait and shuts down when it wakes", async () => {
    const e = env();
    const log: string[] = [];
    const first = new SingleTab({ acquired: () => log.push("1:start"), busy: () => undefined, replaced: () => log.push("1:replaced") }, e.locks, () => null);
    first.start();
    await flush();
    let takeOver: (() => void) | null = null;
    const second = new SingleTab({ acquired: () => log.push("2:start"), busy: (t) => (takeOver = t), replaced: () => undefined }, e.locks, () => null);
    second.start();
    await flush();
    takeOver!();
    await flush();
    expect(log).toEqual(["1:start"]); // first did not answer (no channel)
    vi.advanceTimersByTime(3_000);
    await flush();
    expect(log).toEqual(["1:start", "2:start", "1:replaced"]);
  });

  it("without Web Locks support the app simply starts", () => {
    const log: string[] = [];
    new SingleTab({ acquired: () => log.push("start"), busy: () => undefined, replaced: () => undefined }, null).start();
    expect(log).toEqual(["start"]);
  });
});
