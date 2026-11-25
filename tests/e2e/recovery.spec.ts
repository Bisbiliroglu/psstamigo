/**
 * PA-011 browser tests with real WebRTC between Chromium contexts.
 * Failures are SIMULATED (signaling socket closed, media RTCPeerConnections closed);
 * real network interruptions (Wi-Fi drop, ISP outage) are manual tests.
 */
import { expect, test } from "@playwright/test";
import {
  breakMediaConnections,
  closeSignalingSocket,
  inboundAudioPackets,
  joinVia,
  openClient,
  openPcKinds,
  probe,
  uidOf,
  waitForParticipantActivity,
} from "./helpers";

test("signaling-only outage: the call keeps running, signaling reconnects with the same UID", async ({ browser }) => {
  test.setTimeout(120_000);
  const A = await openClient(browser);
  const B = await openClient(browser);
  const [a, b] = [A.page, B.page];
  const aUid = await uidOf(a);
  await joinVia(b, a, [a]);
  await a.locator("#mic-btn").click();
  await expect(a.locator("#mic-label")).toHaveText("Mikrofon açık");
  await b.locator("#speaker-btn").click();
  await waitForParticipantActivity(b, aUid);

  expect(await closeSignalingSocket(a)).toBeGreaterThan(0);
  await expect(a.locator("#signal-status")).toHaveAttribute("data-state", "reconnecting", { timeout: 10_000 });
  // The P2P call is untouched while signaling is down.
  await expect(a.locator("#session-status")).toContainText("Sinyal yok: mevcut görüşme sürüyor");
  const before = await inboundAudioPackets(b);
  await b.waitForTimeout(1_500);
  expect(await inboundAudioPackets(b)).toBeGreaterThan(before);
  await expect(b.getByTestId("participant").locator(".media")).toHaveText("ses bağlı");

  await expect(a.locator("#signal-status")).toHaveAttribute("data-state", "online", { timeout: 20_000 });
  expect(await uidOf(a)).toBe(aUid); // REC-003
  await expect(a.locator("#mic-label")).toHaveText("Mikrofon açık"); // state unchanged (Scenario A)
  const sa = await probe(a);
  expect(sa.gum).toBe(1);
  expect(sa.sendersWithMic).toBe(1);
  await A.context.close();
  await B.context.close();
});

test("media-only failure: replacement connection, current mic/speaker state, no new capture, no leaks", async ({ browser }) => {
  test.setTimeout(180_000);
  const A = await openClient(browser);
  const B = await openClient(browser);
  const [a, b] = [A.page, B.page];
  const aUid = await uidOf(a);
  await joinVia(b, a, [a]);
  await a.locator("#mic-btn").click();
  await expect(a.locator("#mic-label")).toHaveText("Mikrofon açık");
  await b.locator("#speaker-btn").click();
  await waitForParticipantActivity(b, aUid);

  for (let cycle = 1; cycle <= 3; cycle++) {
    expect(await breakMediaConnections(a)).toBe(1);
    // PeerJS tells B through its internal channel, so B's side may already be closed.
    expect(await breakMediaConnections(b)).toBeLessThanOrEqual(1);
    for (const p of [a, b]) {
      await expect(p.getByTestId("participant").locator(".media")).toHaveText("ses bağlı", { timeout: 45_000 });
    }
    await expect(a.locator("#chat-log")).toContainText("ses yeniden bağlandı");
    // Same single capture re-attached; B still plays (speaker was on); no extra connections.
    const sa = await probe(a);
    expect(sa.gum).toBe(1);
    expect(sa.liveCaptured).toBe(1);
    await expect.poll(async () => (await probe(a)).sendersWithMic).toBe(1);
    await waitForParticipantActivity(b, aUid);
    expect(await openPcKinds(a)).toEqual({ media: 1, data: 1 });
    expect(await openPcKinds(b)).toEqual({ media: 1, data: 1 });
  }

  // Mute during an outage: the recovered path must carry nothing.
  await breakMediaConnections(a);
  await breakMediaConnections(b);
  await a.locator("#mic-btn").click();
  await expect(a.locator("#mic-label")).toHaveText("Mikrofon kapalı");
  await expect(a.getByTestId("participant").locator(".media")).toHaveText("ses bağlı", { timeout: 45_000 });
  const sa = await probe(a);
  expect(sa.liveCaptured).toBe(0);
  expect(sa.sendersWithTrack).toBe(0);
  expect(sa.gum).toBe(1);
  await A.context.close();
  await B.context.close();
});

test("one participant's media fails while the others keep talking", async ({ browser }) => {
  test.setTimeout(150_000);
  const clients = await Promise.all([0, 1, 2].map(() => openClient(browser)));
  const [a, b, c] = clients.map((x) => x.page);
  const [aUid, bUid] = [await uidOf(a!), await uidOf(b!)];
  await joinVia(b!, a!, [a!]);
  await joinVia(c!, b!, [a!, b!]);
  for (const p of [a!, b!]) await p.locator("#mic-btn").click();
  await c!.locator("#speaker-btn").click();
  await waitForParticipantActivity(c!, aUid);
  // C loses all its media paths; A–B is not touched.
  await breakMediaConnections(c!);
  await expect(a!.getByTestId("participant").filter({ hasText: bUid }).locator(".media")).toHaveText("ses bağlı");
  await expect(c!.getByTestId("participant").locator(".media")).toHaveText(["ses bağlı", "ses bağlı"], { timeout: 60_000 });
  await waitForParticipantActivity(c!, aUid);
  await waitForParticipantActivity(c!, bUid);
  for (const x of clients) await x.context.close();
});
