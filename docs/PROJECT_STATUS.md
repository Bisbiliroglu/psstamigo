# Project status

| Field | Value |
|---|---|
| Current version | 0.3.0 (committed and pushed with this update; deployment verified separately) |
| Current branch | `main` |
| Remote | `git@github.com:Bisbiliroglu/psstamigo.git` (public) |
| Test deployment | https://bisbiliroglu.github.io/psstamigo/ |
| Current task | PA-009 — audio devices, settings, diagnostics (+ single active tab) — REVIEW |
| Last update | 2026-11-25 |

## In progress / review

- PA-009 — REVIEW (0.3.0): device selection/switching without silent fallback (D-036), local mic test (D-033), opt-in
  preferences (D-034), volumes/mute, processing toggles, single active tab (D-035)
- PA-011 — REVIEW (0.2.0); PA-006C done in code
- PA-006, PA-006B, PA-015 — REVIEW (manual tests pending)
- PA-001 … PA-005, PA-007, PA-008 — REVIEW
- Priority (D-032): PA-009 (done, REVIEW) → **PA-010 next** → real-world tests → remaining stability/release tasks

## Completed tasks

- none accepted as DONE (real-network and physical-device acceptance pending)

## Last verified build (2026-11-25, macOS, Node 26.13.1)

- `npm audit`: 0 vulnerabilities; runtime: `peerjs@1.5.5` only
- typecheck: pass
- build: JS 49.19 KB, CSS 2.22 KB, HTML 3.55 KB gzip (total about 54.96 KB; 0.2.0 was about 47.7 KB, +7.2 KB)
- no source maps; `noindex`; `connect-src` = self + PeerJS Cloud; no other URLs in the bundle

## Last verified tests (2026-11-25)

- Unit: **208 / 208** (12 files; was 178: +29 `audioDevices.test.ts`, +1 policy scope test; 3 playback tests now await output
  routing because audio plays only after `setSinkId` resolves)
- Browser (Chromium, FAKE mic/outputs, real PeerJS Cloud): **21 tests** (was 16: +5 audio/single-tab)
  - Full dev suite 21 / 21; full production-preview suite 21 / 21; 10-person test 3 / 3.
- Not verified automatically: physical device routing, real headset/USB/Bluetooth behavior, OS rerouting, real permission-
  prompt label behavior (test Chromium auto-grants via a flag).

## Manual test results

### v0.3.0 (audio devices, MANUAL_TESTS section I)

All D-01 … D-26: **NOT RUN** (physical devices required).

### v0.2.0 (recovery, MANUAL_TESTS section H)

All R-01 … R-16: **NOT RUN**.

### v0.1.0 / v0.1.1 (group)

All group scenarios (MANUAL_TESTS.md "Öncelikli 20 test", E, F, G): **NOT RUN**. The v0.0.2 results below are historical and are
not carried over to 0.1.x.

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

- 10-person browser test flaked once in 15 runs (0.2.0), cause unknown (see above).
- Media recovery needs signaling online for the replacement offer; during a signaling outage it waits/uses attempts.
- Recovery cannot fix NAT problems (no TURN); convergence can split a partitioned group into two sessions (no merge).
- A malicious member can trigger removals via false member-sync reports (accepted DoS risk, D-030).
- OS/browser may reroute audio when a selected output disappears before the app is notified (D-036 residual).
- `selectAudioOutput()` is unavailable in Chrome/Edge; output choice relies on enumerateDevices + setSinkId.

- Group membership is not atomic (D-017); simultaneous join requests can both be aborted (`busy`), candidates retry.
- Vanished members are removed after about 30–40 s (D-024); there is no automatic rejoin (PA-011).
- After a partial commit (coordinator dies mid-commit) member lists can differ until someone leaves (D-017); new admissions stop
  while they differ. Convergence is PA-011.
- 10 browser contexts on one machine do not represent 10 real computers; CPU/RAM per participant not measured.
- Full mesh + no TURN: one unreachable pair blocks a newcomer. CPU/upload with 10 people not measured (D-019).
- Low-bandwidth mode audio quality (16 kbps) not verified by ear (D-020).
- No TURN: some NAT/CGNAT (esp. mobile) combinations cannot connect; an error is shown.
- **A requester learns the target's public IP before acceptance** (PeerJS auto-negotiates data connections; D-011).
- Signaling loss: one bounded reconnect only (PA-011).
- Remote tab crash/kill may take up to ~30 s to be detected (data channel / ICE timeout).
- Speaking-indicator thresholds untuned for real voices.

## Technical debt

- Offer audit relies on PeerJS internal `options._payload` (now fail-closed; a PeerJS change breaks calls safely, D-010).
- `SessionController` is about 1200 lines (admission + membership + link + media lifecycle). Proposed separate task PA-006C:
  extract admission/membership into its own module without behavior change.
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
- 2026-11-25: Approved PA-009 with the local mic test (D-033), opt-in preferences (D-034) and Web Locks single tab (D-035).
- 2026-11-25: Approved PA-011 plan: PA-006C first, resume current mic/speaker on media replacement, shrink-only convergence.
- 2026-11-25: Roadmap priority change: PA-009 audio devices first (D-032); asked to commit + push after PA-011.
- 2026-11-25: Approved commit + push + deployment of 0.1.1.
- 2026-11-25: Started PA-006B (stability/privacy review); AGENTS.md (created by Codex) left untracked pending a user decision.
- 2026-11-25: Approved commit + push + deployment of 0.1.0.
- 2026-11-25: Approved PA-006 plan (Phase A). During implementation requested: max **10** participants (D-019),
  low-bandwidth mode above 5 (D-020), invite link button (D-021), compact layout and nicer level animation (D-022).

## Next recommended task

1. Manual tests with real devices: MANUAL_TESTS section I (D-01 … D-26), plus pending sections H, E–G and "Öncelikli 20 test".
2. **PA-010 — UI/UX improvements** (next by D-032).
