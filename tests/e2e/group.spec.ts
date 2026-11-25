/**
 * PA-006 group browser tests: real WebRTC between isolated Chromium contexts,
 * fake microphone, public PeerJS Cloud signaling (internet required).
 */
import { expect, test, type Page } from "@playwright/test";
import {
  diagnosticsDump,
  inboundAudioPackets,
  measuredOutboundBitrates,
  joinVia,
  meterLevel,
  openClient,
  outboundAudioPackets,
  probe,
  requestTo,
  senderMaxBitrates,
  uidOf,
  waitForMeterActivity,
  waitForParticipantActivity,
} from "./helpers";

/** Pages of the running test, for the privacy-safe failure dump. */
let tracked: Page[] = [];
test.beforeEach(() => {
  tracked = [];
});
test.afterEach(async ({}, testInfo) => {
  if (testInfo.status !== testInfo.expectedStatus && tracked.length > 0) {
    await testInfo.attach("group-state.txt", { body: await diagnosticsDump(tracked), contentType: "text/plain" });
    console.log(`[group diagnostics]\n${await diagnosticsDump(tracked)}`);
  }
});

test("three-person group: approval gate, audio, chat, mic/speaker privacy, departures", async ({ browser }) => {
  test.setTimeout(180_000);
  const A = await openClient(browser);
  const B = await openClient(browser);
  const C = await openClient(browser);
  const [a, b, c] = [A.page, B.page, C.page];
  tracked = [a, b, c];
  const [aUid, bUid, cUid] = [await uidOf(a), await uidOf(b), await uidOf(c)];

  // 1–2. A and B connect and talk.
  await joinVia(b, a, [a]);
  await a.locator("#mic-btn").click();
  await expect(a.locator("#mic-label")).toHaveText("Mikrofon açık");
  await b.locator("#mic-btn").click();
  await expect(b.locator("#mic-label")).toHaveText("Mikrofon açık");
  await a.locator("#chat-input").fill("eski mesaj");
  await a.locator("#chat-send").click();
  await expect(b.locator("#chat-log")).toContainText("eski mesaj");

  // 3–4. C asks via B (not the initiator). Before ALL approvals: no media, no audio, no chat for C.
  await requestTo(c, bUid);
  await expect(a.getByTestId("incoming-request")).toContainText("üzerinden");
  await expect(b.getByTestId("incoming-request")).toHaveCount(1);
  await a.getByTestId("incoming-request").getByRole("button", { name: "Kabul et" }).click();
  await expect(c.locator("#session-status")).toContainText("onayı bekleniyor");
  await c.waitForTimeout(1_500);
  let sc = await probe(c);
  expect(sc.openPcs).toBe(1); // only the request data link to B; no media, nothing to A
  expect(sc.playing).toBe(0);
  expect(await inboundAudioPackets(c)).toBe(0);
  await expect(c.locator("#chat-log li")).toHaveCount(0);

  // 5–6. B approves too: everyone sees three people.
  await b.getByTestId("incoming-request").getByRole("button", { name: "Kabul et" }).click();
  for (const p of [a, b, c]) {
    await expect(p.locator("#session-status")).toHaveText("Görüşmede 3/10 kişi var.", { timeout: 45_000 });
    await expect(p.getByTestId("participant")).toHaveCount(2);
  }
  await expect(c.locator("#chat-log")).not.toContainText("eski mesaj"); // no history for newcomers

  // 7. C's mic and speaker stay off; no capture on C.
  sc = await probe(c);
  expect(sc.gum).toBe(0);
  expect(sc.playing).toBe(0);
  await expect(c.locator("#mic-label")).toHaveText("Mikrofon kapalı");
  await expect(c.locator("#speaker-label")).toHaveText("Hoparlör kapalı");

  // 8. Audio between three users: C hears A and B (per-participant meters move).
  await c.locator("#speaker-btn").click();
  await waitForParticipantActivity(c, aUid);
  await waitForParticipantActivity(c, bUid);
  await waitForMeterActivity(c, "speaker-meter");
  await a.locator("#speaker-btn").click();
  await waitForParticipantActivity(a, bUid);

  // 9. Everyone can message everyone.
  for (const [i, p] of [a, b, c].entries()) {
    await p.locator("#chat-input").fill(`selam ${i}`);
    await p.locator("#chat-send").click();
  }
  for (const [i, p] of [a, b, c].entries()) {
    for (let j = 0; j < 3; j++) if (j !== i) await expect(p.locator("#chat-log")).toContainText(`selam ${j}`);
  }

  // 10–12. A mutes: capture ended, every outbound sender detached, RTP stops to ALL peers.
  let sa = await probe(a);
  expect(sa.gum).toBe(1); // one capture shared by both peers
  expect(sa.sendersWithMic).toBe(2);
  await a.locator("#mic-btn").click();
  await expect(a.locator("#mic-label")).toHaveText("Mikrofon kapalı");
  sa = await probe(a);
  expect(sa.liveCaptured).toBe(0);
  await expect.poll(async () => (await probe(a)).sendersWithTrack).toBe(0);
  await a.waitForTimeout(1_000);
  const before = await outboundAudioPackets(a);
  await a.waitForTimeout(2_500);
  expect((await outboundAudioPackets(a)) - before).toBe(0);
  await expect.poll(() => meterLevel(c, `participants [data-peer="${aUid}"] .meter`).catch(() => 0)).toBe(0);

  // 13–14. A turns the speaker off: nothing from B or C is played on A.
  await a.locator("#speaker-btn").click();
  await expect(a.locator("#speaker-label")).toHaveText("Hoparlör kapalı");
  expect((await probe(a)).playing).toBe(0);
  expect(await meterLevel(a, "speaker-meter")).toBe(0);

  // 15–16. A leaves; B and C continue with chat and audio state intact.
  await a.locator("#leave-btn").click();
  await expect(a.locator("#session-status")).toHaveText("Aktif görüşme yok.");
  for (const p of [b, c]) {
    await expect(p.locator("#session-status")).toHaveText("Görüşmede 2/10 kişi var.");
    await expect(p.getByTestId("participant")).toHaveCount(1);
  }
  await expect(b.locator("#mic-label")).toHaveText("Mikrofon açık");
  await expect(c.locator("#speaker-label")).toHaveText("Hoparlör açık");
  await b.locator("#chat-input").fill("hala buradayız");
  await b.locator("#chat-send").click();
  await expect(c.locator("#chat-log")).toContainText("hala buradayız");
  await expect.poll(async () => (await probe(a)).openPcs).toBe(0);

  // 17–19. B closes the tab (page close runs pagehide → leave): C returns to a safe idle state.
  await b.close();
  await expect(c.locator("#session-status")).toHaveText("Aktif görüşme yok.", { timeout: 45_000 });
  await expect(c.locator("#speaker-label")).toHaveText("Hoparlör kapalı");
  await expect(c.locator("#mic-label")).toHaveText("Mikrofon kapalı");
  await expect.poll(async () => (await probe(c)).openPcs).toBe(0);
  sc = await probe(c);
  expect(sc.playing).toBe(0);
  expect(sc.liveCaptured).toBe(0);
  expect(sc.cspViolations).toEqual([]);
  expect(sc.iceUrls.filter((u) => !u.startsWith("stun:"))).toEqual([]);
  expect(sc.gdm).toBe(0);
  expect(await uidOf(c)).toBe(cUid);
  await A.context.close();
  await B.context.close();
  await C.context.close();
});

test("four people: one member rejects; initiator leaves and the rest continue", async ({ browser }) => {
  test.setTimeout(180_000);
  const clients = await Promise.all([0, 1, 2, 3].map(() => openClient(browser)));
  const [a, b, c, d] = clients.map((x) => x.page) as [Page, Page, Page, Page];
  tracked = [a, b, c, d];
  await joinVia(b, a, [a]);
  await joinVia(c, b, [a, b]);

  // D asks via C; B rejects -> D is told, the group is unchanged.
  await requestTo(d, await uidOf(c));
  await expect(b.getByTestId("incoming-request")).toHaveCount(1);
  await b.getByTestId("incoming-request").getByRole("button", { name: "Reddet" }).click();
  await expect(d.locator("#notice")).toContainText("reddedildi", { timeout: 20_000 });
  for (const p of [a, b, c]) await expect(p.locator("#session-status")).toHaveText("Görüşmede 3/10 kişi var.");
  expect((await probe(d)).openPcs).toBe(0);

  // D asks again; everyone approves.
  await joinVia(d, c, [a, b, c]);
  for (const p of [a, b, c, d]) await expect(p.locator("#session-status")).toHaveText("Görüşmede 4/10 kişi var.", { timeout: 45_000 });

  // Initiator A leaves.
  await a.locator("#leave-btn").click();
  for (const p of [b, c, d]) await expect(p.locator("#session-status")).toHaveText("Görüşmede 3/10 kişi var.");
  await d.locator("#chat-input").fill("A gitti, biz buradayız");
  await d.locator("#chat-send").click();
  for (const p of [b, c]) await expect(p.locator("#chat-log")).toContainText("A gitti, biz buradayız");
  for (const x of clients) await x.context.close();
});

test("ten people form a full mesh with low-bandwidth mode; the eleventh is rejected as full", async ({ browser }) => {
  test.setTimeout(480_000);
  const clients = await Promise.all(Array.from({ length: 11 }, () => openClient(browser)));
  const pages = clients.map((x) => x.page);
  tracked = pages;
  for (let i = 1; i < 10; i++) {
    await joinVia(pages[i]!, pages[i - 1]!, pages.slice(0, i));
    if (i === 4) {
      // 5 people: normal quality (browser default bitrate)
      for (const p of pages.slice(0, 5)) {
        await expect(p.locator("#session-status")).toHaveText("Görüşmede 5/10 kişi var.");
        await expect.poll(async () => (await senderMaxBitrates(p)).every((b) => b === null)).toBe(true);
      }
      await pages[0]!.locator("#mic-btn").click();
      const normal = await measuredOutboundBitrates(pages[0]!);
      console.log(`[bitrate] 5 people, normal mode, measured payload bps per stream: ${normal.join(", ")}`);
      await pages[0]!.locator("#mic-btn").click();
    }
  }
  for (const p of pages.slice(0, 10)) {
    await expect(p.locator("#session-status")).toHaveText("Görüşmede 10/10 kişi var. Kalabalık grup: düşük veri modu açık.", {
      timeout: 60_000,
    });
    await expect(p.getByTestId("participant")).toHaveCount(9);
    await expect(p.getByTestId("participant").locator(".media")).toHaveText(Array(9).fill("ses bağlı"), { timeout: 60_000 });
    await expect.poll(async () => await senderMaxBitrates(p)).toEqual(Array(9).fill(16_000));
  }
  // Measured (not just configured) bitrate in low-bandwidth mode with a live synthetic mic.
  await pages[0]!.locator("#mic-btn").click();
  await expect(pages[0]!.locator("#mic-label")).toHaveText("Mikrofon açık");
  const low = await measuredOutboundBitrates(pages[0]!);
  console.log(`[bitrate] 10 people, low-bandwidth mode, measured payload bps per stream: ${low.join(", ")}`);
  expect(low).toHaveLength(9);
  expect(low.every((bps) => bps > 0 && bps <= 16_000 * 1.25)).toBe(true);
  await pages[0]!.locator("#mic-btn").click();
  await expect.poll(async () => (await probe(pages[0]!)).sendersWithTrack).toBe(0);

  const extra = pages[10]!;
  await requestTo(extra, await uidOf(pages[3]!));
  await expect(extra.locator("#notice")).toContainText("kapasitesi dolu", { timeout: 20_000 });
  expect((await probe(extra)).openPcs).toBe(0);
  for (const p of pages.slice(0, 10)) await expect(p.getByTestId("incoming-request")).toHaveCount(0);

  // Leaving below the threshold restores normal quality.
  for (const p of pages.slice(5, 10)) await p.locator("#leave-btn").click();
  for (const p of pages.slice(0, 5)) {
    await expect(p.locator("#session-status")).toHaveText("Görüşmede 5/10 kişi var.", { timeout: 30_000 });
    await expect.poll(async () => (await senderMaxBitrates(p)).every((b) => b === null)).toBe(true);
  }
  for (const x of clients) await x.context.close();
});

test("invite link: asks before sending a request, then the normal approval applies", async ({ browser }) => {
  const A = await openClient(browser);
  tracked = [A.page];
  const aUid = await uidOf(A.page);
  const context = await browser.newContext();
  const b = await context.newPage();
  await b.goto(`./#join=${aUid}`);
  await expect(b.getByTestId("invite-banner")).toBeVisible();
  await expect(b.locator("#invite-uid")).toHaveText(aUid);
  expect(new URL(b.url()).hash).toBe(""); // removed from the address bar
  await expect(b.locator("#signal-status")).toHaveAttribute("data-state", "online", { timeout: 30_000 });
  await b.waitForTimeout(1_000);
  await expect(A.page.getByTestId("incoming-request")).toHaveCount(0); // nothing sent before the click
  await b.locator("#invite-accept").click();
  await expect(b.getByTestId("invite-banner")).toBeHidden();
  await A.page.getByTestId("incoming-request").getByRole("button", { name: "Kabul et" }).click();
  await expect(b.locator("#session-status")).toHaveText("Görüşmede 2/10 kişi var.", { timeout: 45_000 });
  await A.context.close();
  await context.close();
});

test("a peer that vanishes without closing (no pagehide) is removed by the others", async ({ browser }) => {
  test.setTimeout(150_000);
  const clients = await Promise.all([0, 1, 2].map(() => openClient(browser)));
  const [a, b, c] = clients.map((x) => x.page) as [Page, Page, Page];
  tracked = [a, b];
  await joinVia(b, a, [a]);
  await joinVia(c, b, [a, b]);
  await a.locator("#mic-btn").click();
  await expect(a.locator("#mic-label")).toHaveText("Mikrofon açık");
  const t0 = Date.now();
  void clients[2]!.context.close(); // abrupt: no leave message is sent
  for (const p of [a, b]) {
    await expect(p.locator("#session-status")).toHaveText("Görüşmede 2/10 kişi var.", { timeout: 75_000 });
  }
  console.log(`[vanish] removed by both remaining members after ${Date.now() - t0} ms`);
  await expect(a.locator("#chat-log")).toContainText("bağlantı koptu");
  await expect(a.locator("#mic-label")).toHaveText("Mikrofon açık"); // remaining members keep their state
  expect((await probe(a)).sendersWithMic).toBe(1);
  for (const x of clients.slice(0, 2)) await x.context.close();
});
