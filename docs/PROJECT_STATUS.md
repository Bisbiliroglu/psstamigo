# Project status

| Field | Value |
|---|---|
| Current version | 0.1.0 (local working tree, **not committed, not deployed**). Live site serves 0.0.2. |
| Current branch | `main`; `origin/main` = `aca8bba` (0.0.2) |
| Remote | `git@github.com:Bisbiliroglu/psstamigo.git` (public) |
| Test deployment | https://bisbiliroglu.github.io/psstamigo/ (0.0.2) |
| Current task | PA-006 — group mesh (max 10) + user requests: invite links, low-bandwidth mode, compact layout |
| Task status | REVIEW — implemented and verified locally (dev + production preview); waiting for review and deploy approval |
| Last update | 2026-11-25 |

## Completed tasks

- none accepted as DONE yet (real-network acceptance pending)

## In progress / review

- PA-006 — REVIEW (0.1.0)
- PA-015 — REVIEW (0.0.2 live; 0.1.0 not deployed)
- PA-001 … PA-005, PA-007, PA-008 — REVIEW (see ROADMAP remaining criteria)

## Last verified build (2026-11-25, macOS, Node 26.13.1)

- `npm audit`: 0 vulnerabilities; runtime dependencies unchanged (`peerjs@1.5.5` only)
- `npm run typecheck`: pass
- `vite build`: pass. Gzip 0.1.0 vs 0.0.2:
  - JS 39.55 KB (was 35.17, +4.38: group protocol, admission, invite, bandwidth mode)
  - CSS 1.90 KB (was 1.58, +0.32: new layout)
  - HTML 2.60 KB (was 2.11, +0.49)
  - Total ≈ 44.05 KB (was ≈ 38.86, +5.19)
- No source maps; `noindex` + CSP present.

## Last verified tests (2026-11-25)

- Unit (Vitest): **141 / 141 passed** (8 files; was 100). Changes: 1:1 session tests rewritten for protocol v2 on the in-memory
  mesh (19), new `group.test.ts` (33), `invite.test.ts` (2), protocol tests rewritten for v2 (+admission helpers).
- Browser integration (Chromium, fake mic, real PeerJS Cloud): **12 tests** (was 8: +3-person, +4-person, +10-person, +invite).
  - Production preview (CSP): **12 / 12 passed**.
  - Dev server, final full run: **11 / 12 passed — 1 FAILED**: "ten people …" (`toHaveText` wait) in the full-suite run.
    The same test then passed **6 times in a row** (5 isolated reruns + preview suite). Classified as **flaky under load**
    (10–11 browser contexts with up to 18 peer connections each on one machine); not hidden, tracked as known issue.
  - Earlier dev full run in this task: 12 / 12 passed.
- Not run: GitHub Actions for 0.1.0 (no push), live smoke test (not deployed), manual tests.

## Manual test results

Checklist: [MANUAL_TESTS.md](MANUAL_TESTS.md).

### v0.0.2 — reported by the user (2026-11-25)

Browser, OS, network topology, test duration, RTT, jitter, packet loss and CPU/RAM were **not reported** (not estimated here).
PARTIAL = the reported observation covers only part of the scenario's acceptance criteria.

| ID | Result | Reported observation / missing part |
|---|---|---|
| P-01 | PASS | No microphone permission request on page load |
| B-03 | PASS | Connection request by UID can be sent |
| B-06 | PASS | Messaging works with mic and speaker off |
| B-07 | PASS | Mic can be enabled; mic indicator follows real voice |
| B-08 | PASS | Remote side hears the voice; speaker indicator follows incoming audio |
| P-12 | PASS | Camera / screen sharing permission never requested |
| P-03 | PARTIAL | Browser mic indicator disappears on mute; Windows taskbar indicator not reported |
| P-05 | PARTIAL | No remote audio with speaker off; indicator staying idle not reported |
| P-07 | PARTIAL | Mic does not turn on after acceptance; speaker not reported |
| P-08 / B-13 | PARTIAL | Closing the tab ends voice; recording icon and remote idle timing not reported |
| P-09 | PARTIAL | Reload does not resume the old call; new UID / mic-off start not reported |
| B-09 | NOT RUN | Two-way voice not explicitly reported |
| N-03 | NOT RUN | Different ISPs not tested |
| G-01 … G-04 | NOT CONFIRMED | Attempted by the user, not marked PASS |
| N-01, N-02, N-04, N-05, B-01, B-02, B-04, B-05, B-10 … B-12, P-02, P-04, P-06, P-10, P-11, G-05 … G-07 | NOT RUN | — |

Remaining real-network tests (N-03 … N-05, G-xx on Windows Chrome/Edge) are kept as a **release acceptance gate**.

## Known issues

- Group membership is not atomic (D-017); simultaneous join requests can both be aborted (`busy`), candidates retry.
- 10-person e2e test is flaky under local load (1 failure in 7 runs).
- A crashed/killed tab (no `pagehide`) may be detected late by others (> 30 s observed in e2e with `context.close()`);
  normal tab close / reload is immediate. Full detection/recovery is PA-011.
- Full mesh + no TURN: one unreachable pair blocks a newcomer. CPU/upload with 10 people not measured (D-019).
- Low-bandwidth mode audio quality (16 kbps) not verified by ear (D-020).
- No TURN: some NAT/CGNAT (esp. mobile) combinations cannot connect; an error is shown.
- **A requester learns the target's public IP before acceptance** (PeerJS auto-negotiates data connections; D-011).
- Signaling loss: one bounded reconnect only (PA-011).
- Remote tab crash/kill may take up to ~30 s to be detected (data channel / ICE timeout).
- Speaking-indicator thresholds untuned for real voices.

## Technical debt

- Offer audit relies on PeerJS internal `options._payload` (now fail-closed; a PeerJS change breaks calls safely, D-010).
- `SessionController` grew to ~1100 lines (admission + mesh + media); splitting admission into its own class may help later.
- E2E depends on public PeerJS Cloud.
- Bundled `webrtc-adapter` contains unused `getDisplayMedia` shim; PeerJS feature detection creates one closed, never-negotiated
  `RTCPeerConnection` with its default TURN config (verified harmless in e2e).

## User decisions

- 2026-11-25: Project name PsstAmigo (final); repo `psstamigo`; task prefix PA.
- 2026-11-25: Approved Phase 1 recommendations — STUN only (PeerJS default TURN disabled), approach A (D-002).
- 2026-11-25: Public GitHub repo created by the user; leak prevention requested (noreply identity, no personal data).
- 2026-11-25: Approved initial commit, push and GitHub Pages enablement (0.0.1 deployed).
- 2026-11-25: Approved roadmap reordering; PA-015 brought forward as test deployment only (D-015).
- 2026-11-25: Approved commit + push of 0.0.2 review fixes (deployed).
- 2026-11-25: Approved PA-006 plan (Phase A). During implementation requested: max **10** participants (D-019),
  low-bandwidth mode above 5 (D-020), invite link button (D-021), compact layout and nicer level animation (D-022).

## Next recommended task

1. User reviews 0.1.0 locally or approves commit + push (auto-deploys 0.1.0 to GitHub Pages), then live smoke test.
2. Group manual tests ([MANUAL_TESTS.md](MANUAL_TESTS.md) sections E–G) and the pending real-network tests (release gate).
3. Then PA-011 (reconnection / crashed-peer detection) or PA-009 (audio settings, per-participant volume).
