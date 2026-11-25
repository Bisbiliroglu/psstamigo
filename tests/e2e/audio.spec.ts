/**
 * PA-009 browser tests: Chromium FAKE audio devices (two inputs, two outputs). They verify selection,
 * switching and routing logic with real browser APIs; they do NOT verify physical hardware routing.
 */
import { expect, test, type Page } from "@playwright/test";
import { joinVia, openClient, probe, uidOf } from "./helpers";

async function openSettings(page: Page): Promise<void> {
  await page.locator("#audio-settings summary").click();
  await expect(page.locator("#mic-device")).toBeVisible();
}

/** Option values of a device select, excluding the "system default" entry. */
async function deviceIds(page: Page, select: string): Promise<string[]> {
  return page.locator(`${select} option`).evaluateAll((opts) =>
    (opts as HTMLOptionElement[]).map((o) => o.value).filter((v) => v !== "__default"),
  );
}

async function liveTrackDevices(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    (window as unknown as { __probe: { tracks: MediaStreamTrack[] } }).__probe.tracks
      .filter((t) => t.readyState === "live")
      .map((t) => t.getSettings().deviceId ?? ""),
  );
}

async function playerSinks(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    (window as unknown as { __probe: { players: HTMLMediaElement[] } }).__probe.players
      .filter((m) => !m.paused && m.srcObject !== null)
      .map((m) => (m as HTMLMediaElement & { sinkId: string }).sinkId),
  );
}

test("settings panel: lists audio devices without requesting the microphone", async ({ browser }) => {
  const A = await openClient(browser);
  await openSettings(A.page);
  await expect.poll(async () => (await deviceIds(A.page, "#mic-device")).length).toBeGreaterThan(0);
  await A.page.locator("#refresh-devices").click();
  const s = await probe(A.page);
  expect(s.gum).toBe(0);
  expect(s.gdm).toBe(0);
  await A.context.close();
});

test("microphone switch during a group call: one capture, new device on every sender, old track ended", async ({ browser }) => {
  test.setTimeout(150_000);
  const clients = await Promise.all([0, 1, 2].map(() => openClient(browser)));
  const [a, b, c] = clients.map((x) => x.page) as [Page, Page, Page];
  await joinVia(b, a, [a]);
  await joinVia(c, b, [a, b]);
  await a.locator("#mic-btn").click();
  await expect(a.locator("#mic-label")).toHaveText("Mikrofon açık");
  await openSettings(a);
  const ids = await deviceIds(a, "#mic-device");
  expect(ids.length).toBeGreaterThanOrEqual(2);
  const target = ids[1]!;
  await a.locator("#mic-device").selectOption(target);
  await expect(a.locator("#mic-label")).toHaveText("Mikrofon açık");
  await expect.poll(() => liveTrackDevices(a)).toEqual([target]);
  const s = await probe(a);
  expect(s.liveCaptured).toBe(1);
  expect(s.gum).toBe(2);
  await expect.poll(async () => (await probe(a)).sendersWithMic).toBe(2);
  await expect(a.locator("#mic-active")).toContainText("Aktif mikrofon");
  // Selecting while muted never captures.
  await a.locator("#mic-btn").click();
  await expect(a.locator("#mic-label")).toHaveText("Mikrofon kapalı");
  await a.locator("#mic-device").selectOption(ids[0]!);
  await a.waitForTimeout(500);
  expect((await probe(a)).gum).toBe(2);
  expect((await probe(a)).liveCaptured).toBe(0);
  for (const x of clients) await x.context.close();
});

test("output selection routes every player (incl. a newcomer); local volume and mute", async ({ browser }) => {
  test.setTimeout(150_000);
  const clients = await Promise.all([0, 1, 2].map(() => openClient(browser)));
  const [a, b, c] = clients.map((x) => x.page) as [Page, Page, Page];
  await joinVia(b, a, [a]);
  await openSettings(a);
  const outs = await deviceIds(a, "#out-device");
  expect(outs.length).toBeGreaterThanOrEqual(1);
  const target = outs[outs.length - 1]!;
  await a.locator("#out-device").selectOption(target); // speaker still off: must not play
  await a.waitForTimeout(500);
  expect((await probe(a)).playing).toBe(0);
  await a.locator("#speaker-btn").click();
  await expect.poll(() => playerSinks(a)).toEqual([target]);
  await joinVia(c, b, [a, b]);
  await expect.poll(() => playerSinks(a)).toEqual([target, target]);
  // Per-participant volume (local only) and mute.
  const bUid = await uidOf(b);
  const row = a.locator(`[data-peer="${bUid}"]`);
  await row.locator(".pvol").fill("40");
  await row.locator(".pmute").click();
  await expect(row.locator(".pmute")).toHaveText("Sessizde");
  const vols = await a.evaluate(() =>
    (window as unknown as { __probe: { players: HTMLMediaElement[] } }).__probe.players
      .filter((m) => !m.paused && m.srcObject !== null)
      .map((m) => m.volume),
  );
  expect(vols.sort()).toEqual([0, 1]);
  await row.locator(".pmute").click();
  await expect.poll(async () =>
    (await a.evaluate(() =>
      (window as unknown as { __probe: { players: HTMLMediaElement[] } }).__probe.players
        .filter((m) => !m.paused && m.srcObject !== null)
        .map((m) => m.volume),
    )).sort(),
  ).toEqual([0.4, 1]);
  for (const x of clients) await x.context.close();
});

test("local mic test: explicit, never sent, cleaned up on panel close; disabled during a call", async ({ browser }) => {
  test.setTimeout(120_000);
  const A = await openClient(browser);
  const B = await openClient(browser);
  const a = A.page;
  await openSettings(a);
  await a.locator("#mic-test").click();
  await expect(a.locator("#mic-test")).toHaveText("Testi durdur");
  await expect.poll(async () => (await probe(a)).liveCaptured).toBe(1); // capture starts after permission resolves
  let s = await probe(a);
  expect(s.gum).toBe(1);
  expect(s.liveCaptured).toBe(1);
  expect(s.sendersWithTrack).toBe(0); // never attached to any sender
  expect(s.playing).toBe(0); // no sidetone
  await a.locator("#audio-settings summary").click(); // close panel
  await expect.poll(async () => (await probe(a)).liveCaptured).toBe(0);
  // During a call the test is disabled (no second capture).
  await joinVia(B.page, a, [a]);
  await openSettings(a);
  await expect(a.locator("#mic-test")).toBeDisabled();
  // Speaker test does not turn on conversation playback.
  await a.locator("#speaker-test").click();
  await expect(a.locator("#speaker-test")).toHaveText("Hoparlörü test et", { timeout: 10_000 });
  await expect(a.locator("#speaker-label")).toHaveText("Hoparlör kapalı");
  s = await probe(a);
  expect(s.playing).toBe(0);
  expect(s.gum).toBe(1);
  await A.context.close();
  await B.context.close();
});

test("single active tab: a second tab does not join until the user takes over", async ({ browser }) => {
  const context = await browser.newContext();
  const first = await context.newPage();
  await first.goto("./");
  await expect(first.locator("#signal-status")).toHaveAttribute("data-state", "online", { timeout: 30_000 });
  const firstUid = (await first.locator("#my-uid").textContent())?.trim();
  const second = await context.newPage();
  await second.goto("./");
  await expect(second.locator("#tab-guard")).toBeVisible();
  await second.waitForTimeout(1_000);
  await expect(second.locator("#my-uid")).toHaveText("—"); // no UID, no signaling in the waiting tab
  await second.locator("#tab-guard-continue").click();
  await expect(second.locator("#tab-guard")).toBeHidden({ timeout: 10_000 });
  await expect(second.locator("#signal-status")).toHaveAttribute("data-state", "online", { timeout: 30_000 });
  await expect(first.locator("main")).toContainText("başka bir sekmede açıldı");
  expect((await second.locator("#my-uid").textContent())?.trim()).not.toBe(firstUid);
  await context.close();
});
