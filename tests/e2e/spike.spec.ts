/**
 * PA-001 browser integration tests (Chromium, fake microphone device,
 * real PeerJS Cloud signaling, both peers on this machine).
 * These do NOT replace the manual real-network tests in docs/TEST_PLAN.md.
 */
import { expect, test } from "@playwright/test";
import { connectPair, meterLevel, openClient, outboundAudioPackets, probe, requestTo, uidOf, waitForMeterActivity } from "./helpers";

test("first load: no permission request, no media, noindex present", async ({ browser }) => {
  const { page, context } = await openClient(browser);
  const s = await probe(page);
  expect(s.gum).toBe(0);
  expect(s.gdm).toBe(0);
  expect(s.playing).toBe(0);
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "noindex, nofollow");
  await expect(page.locator("#mic-btn")).toBeDisabled();
  await expect(page.locator("#speaker-btn")).toBeDisabled();
  await context.close();
});

test("request, accept, chat, real mic on/off, speaker on/off, leave", async ({ browser }) => {
  const A = await openClient(browser);
  const B = await openClient(browser);
  const a = A.page;
  const b = B.page;
  const bUid = await uidOf(b);

  // Before acceptance: request visible, no media capture or call on either side.
  await requestTo(b, await uidOf(a));
  await expect(a.getByTestId("incoming-request")).toHaveCount(1);
  for (const p of [a, b]) expect((await probe(p)).gum).toBe(0);
  expect((await probe(b)).sendersWithTrack).toBe(0);

  await a.getByTestId("incoming-request").getByRole("button", { name: "Kabul et" }).click();
  for (const p of [a, b]) {
    await expect(p.getByTestId("participant").locator(".media")).toHaveText("ses bağlı", { timeout: 30_000 });
  }

  // Joining did not turn mic or speaker on (PRIV-001, PRIV-003).
  for (const p of [a, b]) {
    const s = await probe(p);
    expect(s.gum).toBe(0);
    expect(s.sendersWithTrack).toBe(0);
    expect(s.playing).toBe(0);
    await expect(p.locator("#mic-label")).toHaveText("Mikrofon kapalı");
    await expect(p.locator("#speaker-label")).toHaveText("Hoparlör kapalı");
  }

  // Chat with mic and speaker off; HTML is rendered as text.
  await b.locator("#chat-input").fill("<b>selam</b> amigo");
  await b.locator("#chat-send").click();
  await expect(a.locator("#chat-log")).toContainText("<b>selam</b> amigo");
  expect(await a.locator("#chat-log b").count()).toBe(0);

  // B enables the microphone explicitly.
  await b.locator("#mic-btn").click();
  await expect(b.locator("#mic-label")).toHaveText("Mikrofon açık");
  let sb = await probe(b);
  expect(sb.gum).toBe(1);
  expect(sb.constraints[0]).toContain('"video":false');
  expect(sb.liveCaptured).toBe(1);
  await expect.poll(async () => (await probe(b)).sendersWithMic).toBe(1);
  await waitForMeterActivity(b, "mic-meter");

  // A has not enabled the speaker: nothing plays, indicator stays at 0.
  expect((await probe(a)).playing).toBe(0);
  expect(await meterLevel(a, "speaker-meter")).toBe(0);

  // A enables the speaker: real remote signal drives the indicator.
  await a.locator("#speaker-btn").click();
  await expect(a.locator("#speaker-label")).toHaveText("Hoparlör açık");
  await expect.poll(async () => (await probe(a)).playing).toBe(1);
  await waitForMeterActivity(a, "speaker-meter");

  // B disables the mic: capture ended, sender detached, RTP stops (PRIV-002).
  await b.locator("#mic-btn").click();
  await expect(b.locator("#mic-label")).toHaveText("Mikrofon kapalı");
  sb = await probe(b);
  expect(sb.liveCaptured).toBe(0); // capture stopped synchronously
  await expect.poll(async () => (await probe(b)).sendersWithTrack).toBe(0); // replaceTrack(null) is async
  expect(await meterLevel(b, "mic-meter")).toBe(0);
  await b.waitForTimeout(1_000);
  const before = await outboundAudioPackets(b);
  await b.waitForTimeout(2_500);
  const after = await outboundAudioPackets(b);
  expect(after - before).toBe(0);
  await expect.poll(() => meterLevel(a, "speaker-meter"), { timeout: 10_000 }).toBe(0);

  // Data channel still works with the mic off.
  await a.locator("#chat-input").fill("hala buradayım");
  await a.locator("#chat-send").click();
  await expect(b.locator("#chat-log")).toContainText("hala buradayım");

  // Toggle again: fresh capture each time, nothing stale remains.
  for (let i = 0; i < 2; i++) {
    await b.locator("#mic-btn").click();
    await expect(b.locator("#mic-label")).toHaveText("Mikrofon açık");
    await b.locator("#mic-btn").click();
    await expect(b.locator("#mic-label")).toHaveText("Mikrofon kapalı");
  }
  sb = await probe(b);
  expect(sb.gum).toBe(3);
  expect(sb.capturedTotal).toBe(3);
  expect(sb.liveCaptured).toBe(0);

  // Speaker off: playback stops and indicator resets (mic state unaffected).
  await a.locator("#speaker-btn").click();
  await expect(a.locator("#speaker-label")).toHaveText("Hoparlör kapalı");
  expect((await probe(a)).playing).toBe(0);
  expect(await meterLevel(a, "speaker-meter")).toBe(0);

  // Background signals must not end the call (PRIV-005).
  await a.evaluate(() => {
    window.dispatchEvent(new Event("blur"));
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await a.waitForTimeout(500);
  await expect(a.getByTestId("participant")).toHaveCount(1);

  // B leaves: everything torn down on both sides, B keeps its UID.
  await b.locator("#leave-btn").click();
  for (const p of [a, b]) {
    await expect(p.locator("#session-status")).toHaveText("Aktif görüşme yok.");
    await expect(p.getByTestId("participant")).toHaveCount(0);
    await expect(p.locator("#chat-log li")).toHaveCount(0);
  }
  await expect.poll(async () => (await probe(b)).openPcs).toBe(0);
  await expect.poll(async () => (await probe(a)).openPcs).toBe(0);
  expect((await probe(a)).playing).toBe(0);
  expect(await uidOf(b)).toBe(bUid);

  for (const p of [a, b]) expect((await probe(p)).gdm).toBe(0);
  await A.context.close();
  await B.context.close();
});

test("rejected request never creates a media connection", async ({ browser }) => {
  const A = await openClient(browser);
  const B = await openClient(browser);
  await requestTo(B.page, await uidOf(A.page));
  await A.page.getByTestId("incoming-request").getByRole("button", { name: "Reddet" }).click();
  await expect(B.page.locator("#notice")).toContainText("reddedildi");
  await expect(B.page.locator("#session-status")).toHaveText("Aktif görüşme yok.");
  await expect.poll(async () => (await probe(B.page)).openPcs).toBe(0);
  for (const p of [A.page, B.page]) expect((await probe(p)).gum).toBe(0);
  await A.context.close();
  await B.context.close();
});

test("invalid and self UID are rejected locally", async ({ browser }) => {
  const A = await openClient(browser);
  await requestTo(A.page, "psst-zzzz");
  await expect(A.page.locator("#notice")).toContainText("Geçersiz UID");
  await requestTo(A.page, await uidOf(A.page));
  await expect(A.page.locator("#notice")).toContainText("Kendinize");
  await A.context.close();
});

test("mic permission denied: chat and receiving audio still work", async ({ browser }) => {
  const A = await openClient(browser);
  const B = await openClient(browser, { denyMic: true });
  await connectPair(A.page, B.page);

  await B.page.locator("#mic-btn").click();
  await expect(B.page.locator("#audio-error")).toContainText("izni verilmedi");
  await expect(B.page.locator("#mic-label")).toHaveText("Mikrofon kapalı");

  await B.page.locator("#chat-input").fill("mikrofonum yok");
  await B.page.locator("#chat-send").click();
  await expect(A.page.locator("#chat-log")).toContainText("mikrofonum yok");

  await A.page.locator("#mic-btn").click();
  await B.page.locator("#speaker-btn").click();
  await waitForMeterActivity(B.page, "speaker-meter");
  await A.context.close();
  await B.context.close();
});

test("leaving while the microphone is starting releases the late capture", async ({ browser }) => {
  const A = await openClient(browser);
  const B = await openClient(browser, { micDelayMs: 1_500 });
  await connectPair(A.page, B.page);

  await B.page.locator("#mic-btn").click();
  await expect(B.page.locator("#mic-label")).toHaveText("Mikrofon açılıyor…");
  await B.page.locator("#leave-btn").click();
  await B.page.waitForTimeout(2_500);
  const s = await probe(B.page);
  expect(s.gum).toBe(1);
  expect(s.liveCaptured).toBe(0);
  expect(s.sendersWithTrack).toBe(0);
  await expect(B.page.locator("#mic-label")).toHaveText("Mikrofon kapalı");
  await A.context.close();
  await B.context.close();
});

test("reload ends the call and yields a new UID", async ({ browser }) => {
  const A = await openClient(browser);
  const B = await openClient(browser);
  await connectPair(A.page, B.page);
  const oldUid = await uidOf(B.page);

  await B.page.reload();
  await expect(B.page.locator("#signal-status")).toHaveAttribute("data-state", "online", { timeout: 30_000 });
  expect(await uidOf(B.page)).not.toBe(oldUid);
  await expect(B.page.locator("#session-status")).toHaveText("Aktif görüşme yok.");
  await expect(A.page.locator("#session-status")).toHaveText("Aktif görüşme yok.", { timeout: 30_000 });
  await A.context.close();
  await B.context.close();
});
