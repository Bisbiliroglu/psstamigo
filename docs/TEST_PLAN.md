# Test plan

Automated and manual results are reported separately. Manual / real-network tests are never marked PASS without the user.

## 1. Unit tests (Vitest, Node) — `npm test`

| File | Covers |
|---|---|
| `tests/unit/core.test.ts` | UID format, uniqueness, unbiased sampling, validation; rate limiter; level mapping & hysteresis; chat cap |
| `tests/unit/protocol.test.ts` | schema validation, malformed/oversized/prototype input, control & bidi characters |
| `tests/unit/audio.test.ts` | mic off by default, audio-only constraints, real shutdown, re-enable, stale gUM races, device-ended fallback; speaker default off, disable, new participant |
| `tests/unit/fakeNetwork.ts` | in-memory mesh: real SessionController + MicrophoneController + SpeakerController per node |
| `tests/unit/group.test.ts` | 3-person admission via non-initiator, 10 + 1 capacity, all-member approval, single rejection, vote timeout, duplicate/forged approval, own-approval enforcement, stale snapshot, replay/foreign sid, simultaneous joins, duplicate links, video/unreadable/invalid offers, partial failure rollback, candidate disconnect, initiator/coordinator/member departure, killed tab, last-member cleanup, commit-gated mic/speaker, mic/speaker change during admission, mic off for all peers, pending getUserMedia races, stale callbacks, group chat fan-out/dedup/impersonation/no history, chat with failed media, idempotent cleanup, low-bandwidth mode |
| `tests/unit/invite.test.ts` | invite URL in fragment, validation |
| `tests/unit/session.test.ts` (rewritten for v2) | authorization (no media before accept, stranger/duplicate/video calls closed), handshake & request timeouts, busy, outgoing flow, reject, unavailable UID, chat rate limit, leave & dispose |
| `tests/unit/policy.test.ts` | static privacy checks on app sources (incl. no track `clone()`, no TURN), PeerJS import boundary, STUN-only config, noindex |
| `tests/unit/sdpPolicy.test.ts` | fail-closed offer audit: audio-only (+PeerJS data channel) accepted; video, unreadable, invalid, oversized rejected |

## 2. Browser integration tests (Playwright, Chromium) — `npm run test:e2e`

Two isolated browser contexts on one machine, Chromium fake microphone (synthetic beep), **real PeerJS Cloud** (internet required).
An init script observes `getUserMedia`, `RTCPeerConnection` and media playback without changing behavior.

| Test | Verifies |
|---|---|
| first load | no `getUserMedia`/`getDisplayMedia`, no playback, noindex, controls disabled |
| main flow | request → no media before accept → accept → mic/speaker still off → chat (HTML inert) → mic on (audio-only, sender has mic track, meter moves) → speaker on (remote meter moves) → mic off (track ended, no sender track, **outbound RTP stops**, remote meter 0) → chat still works → repeated toggles leave no live track → speaker off → synthetic blur/visibility does not end call → leave (all peer connections closed both sides, chat cleared, UID kept) |
| reject | no media connection, both sides idle |
| invalid / self UID | local validation messages |
| mic denied | error shown, chat works, can still receive audio |
| leave while mic starting | late capture stopped, nothing attached |
| reload | new UID, other side returns to idle |
| framed page | app refuses to start inside an iframe (no UID, no signaling socket) |
| group: three people (`group.spec.ts`) | the mandatory 19-step flow: C via B, no media/audio/chat before all approvals (getStats inbound = 0), commit, C muted, 3-way audio via per-participant meters, all-to-all chat, A mutes ⇒ capture ended + all senders detached + outbound RTP stops, A speaker off ⇒ no playback, A leaves ⇒ B/C continue, B closes tab ⇒ C safe idle, no TURN, no CSP violation |
| group: four people | one member rejects, retry, initiator leaves |
| group: ten people | full mesh 10/10, low-bandwidth mode (all senders 16 kbps), 11th rejected as full, back to normal at 5 |
| invite link | banner, fragment removed, nothing sent before click, normal approval |

The main flow additionally asserts: no CSP violations, and every peer connection that starts ICE is STUN-only
(PeerJS's load-time feature-detection connection never negotiates).

Run against the dev server (`npm run test:e2e`) or the production build with CSP (`npm run test:e2e:preview`).
CI runs the dev-server variant in `browser-tests.yml` (separate from the deploy gate, no retries).

Limits: Chromium only (not Edge/Windows), loopback network (host candidates), fake device, synthetic background events.

## 3. Manual tests (user)

The Turkish step-by-step checklist and report template for testers is in [MANUAL_TESTS.md](MANUAL_TESTS.md).
Summary of scenarios:

Open the site (dev: `npm run dev` → `http://localhost:5173/psstamigo/`; deployed: GitHub Pages URL) in **Chrome or Edge**.

### 3.1 Same computer, two browser profiles/windows
1. Open two windows (e.g. normal + InPrivate/Incognito). No permission prompt appears.
2. Window B: paste A's UID → Bağlan. A: a request appears → Kabul et.
3. Both show "ses bağlı". Mic and speaker labels say "kapalı"; the browser shows **no** recording indicator.
4. Send messages both ways.
5. B: Mikrofon → browser asks permission → allow. Tab shows the red recording dot. Mic meter moves when speaking.
6. A: Hoparlör → (use headphones to avoid feedback) you hear B; A's speaker meter moves.
7. B: Mikrofon kapalı → **recording dot disappears** within ~1 s; A hears nothing; A's meter drops to 0.
8. A: Hoparlör kapalı → silence; meter 0.
9. Switch tabs / Alt+Tab / minimize: call continues.
10. B: Ayrıl → both idle; chat cleared. Reload: new UID.

### 3.2 Two computers on the same LAN — repeat 3.1 steps 2–10.
### 3.3 Two computers on different internet connections (e.g. two homes / ISPs) — repeat.
### 3.4 Home internet ↔ mobile hotspot — repeat; note whether it connects. Failure must show an error, not a fake success.
### 3.5 Mobile hotspot ↔ mobile hotspot (different operators if possible) — expected to fail more often without TURN.
### 3.6 Gaming: run a full-screen game for 15+ minutes with the call in a background tab. Check audio continuity, CPU/RAM in Task Manager.
### 3.7 Close the tab during a call: the other side returns to idle within a few seconds.

For each: record browser/OS, network types, connect yes/no, diagnostics "yol" (host/srflx), RTT, any issues.
Results go into `docs/PROJECT_STATUS.md` → Manual test results.
