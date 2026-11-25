import { expect, type Browser, type BrowserContext, type Page } from "@playwright/test";

export interface ProbeOptions {
  denyMic?: boolean;
  micDelayMs?: number;
}

/**
 * Instrumentation injected before the app loads. It observes (never changes)
 * getUserMedia, RTCPeerConnection and media playback so tests can verify
 * privacy behavior from the outside.
 */
function installProbe(opts: ProbeOptions): void {
  type Probe = {
    gum: number;
    gdm: number;
    constraints: string[];
    tracks: MediaStreamTrack[];
    pcs: RTCPeerConnection[];
    players: HTMLMediaElement[];
  };
  const probe: Probe = { gum: 0, gdm: 0, constraints: [], tracks: [], pcs: [], players: [] };
  (window as unknown as { __probe: Probe }).__probe = probe;

  const md = navigator.mediaDevices;
  const originalGum = md.getUserMedia.bind(md);
  md.getUserMedia = async (c?: MediaStreamConstraints) => {
    probe.gum++;
    probe.constraints.push(JSON.stringify(c ?? null));
    if (opts.micDelayMs) await new Promise((r) => setTimeout(r, opts.micDelayMs));
    if (opts.denyMic) throw new DOMException("Permission denied", "NotAllowedError");
    const stream = await originalGum(c);
    for (const t of stream.getTracks()) probe.tracks.push(t);
    return stream;
  };
  if ("getDisplayMedia" in md) {
    md.getDisplayMedia = () => {
      probe.gdm++;
      return Promise.reject(new DOMException("blocked by test", "NotAllowedError"));
    };
  }
  const OriginalPC = window.RTCPeerConnection;
  window.RTCPeerConnection = class extends OriginalPC {
    constructor(config?: RTCConfiguration) {
      super(config);
      probe.pcs.push(this);
    }
  } as typeof RTCPeerConnection;
  const originalPlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
    if (!probe.players.includes(this)) probe.players.push(this);
    return originalPlay.call(this);
  };
}

export async function openClient(browser: Browser, opts: ProbeOptions = {}): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.addInitScript(installProbe, opts);
  await page.goto("./");
  await expect(page.locator("#signal-status")).toHaveAttribute("data-state", "online", { timeout: 30_000 });
  return { context, page };
}

export async function uidOf(page: Page): Promise<string> {
  const uid = (await page.locator("#my-uid").textContent())?.trim() ?? "";
  expect(uid).toMatch(/^psst-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/);
  return uid;
}

export async function requestTo(page: Page, uid: string): Promise<void> {
  await page.locator("#target-uid").fill(uid);
  await page.locator("#connect-btn").click();
}

export interface ProbeState {
  gum: number;
  gdm: number;
  constraints: string[];
  liveCaptured: number;
  capturedTotal: number;
  /** Audio senders currently carrying a captured (microphone) track. */
  sendersWithMic: number;
  /** Audio senders carrying any track at all. */
  sendersWithTrack: number;
  playing: number;
  openPcs: number;
}

export async function probe(page: Page): Promise<ProbeState> {
  return page.evaluate(() => {
    const p = (window as unknown as {
      __probe: {
        gum: number;
        gdm: number;
        constraints: string[];
        tracks: MediaStreamTrack[];
        pcs: RTCPeerConnection[];
        players: HTMLMediaElement[];
      };
    }).__probe;
    const open = p.pcs.filter((pc) => pc.signalingState !== "closed");
    const senders = open.flatMap((pc) => pc.getSenders());
    return {
      gum: p.gum,
      gdm: p.gdm,
      constraints: p.constraints,
      liveCaptured: p.tracks.filter((t) => t.readyState === "live").length,
      capturedTotal: p.tracks.length,
      sendersWithMic: senders.filter((s) => s.track !== null && p.tracks.includes(s.track)).length,
      sendersWithTrack: senders.filter((s) => s.track !== null).length,
      playing: p.players.filter((m) => !m.paused && m.srcObject !== null).length,
      openPcs: open.length,
    };
  });
}

/** Total outbound audio RTP packets across all open peer connections. */
export async function outboundAudioPackets(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const p = (window as unknown as { __probe: { pcs: RTCPeerConnection[] } }).__probe;
    let total = 0;
    for (const pc of p.pcs) {
      if (pc.signalingState === "closed") continue;
      const stats = await pc.getStats();
      stats.forEach((r: { type: string; kind?: string; packetsSent?: number }) => {
        if (r.type === "outbound-rtp" && r.kind === "audio") total += r.packetsSent ?? 0;
      });
    }
    return total;
  });
}

/** Connects B -> A and accepts on A. Waits until the voice path is up. */
export async function connectPair(a: Page, b: Page): Promise<void> {
  await requestTo(b, await uidOf(a));
  const request = a.getByTestId("incoming-request");
  await expect(request).toHaveCount(1);
  await request.getByRole("button", { name: "Kabul et" }).click();
  for (const page of [a, b]) {
    await expect(page.getByTestId("participant")).toHaveCount(1);
    await expect(page.getByTestId("participant").locator(".media")).toHaveText("ses bağlı", { timeout: 30_000 });
  }
}

export async function meterLevel(page: Page, id: string): Promise<number> {
  return Number((await page.locator(`#${id}`).getAttribute("data-level")) ?? "0");
}

/**
 * Waits until a level indicator shows activity. Chromium's fake microphone emits
 * short periodic beeps, so the indicator is sampled on every animation frame.
 */
export async function waitForMeterActivity(page: Page, id: string, timeout = 15_000): Promise<void> {
  await page.waitForFunction(
    (meterId) => Number(document.getElementById(meterId)?.dataset["level"] ?? "0") > 0,
    id,
    { polling: "raf", timeout },
  );
}
