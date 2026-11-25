# Project status

| Field | Value |
|---|---|
| Current version | 0.1.1 (deployed as test build) |
| Current branch | `main` = `origin/main` (PA-006B commit `12be0f5` + this status update) |
| Remote | `git@github.com:Bisbiliroglu/psstamigo.git` (public) |
| Test deployment | https://bisbiliroglu.github.io/psstamigo/ (0.1.1) |
| Current task | PA-006B — Group stability, privacy review & deployment readiness |
| Task status | REVIEW — deployed and verified live; manual tests pending |
| Last update | 2026-11-25 |

Note: the PA-006B task brief listed the deployed version as 0.0.2; the repository shows 0.1.0 was already deployed (user-approved,
commits `5308393`, `a741326`).

## Completed tasks

- none accepted as DONE (real-network acceptance pending)

## In progress / review

- PA-006B — REVIEW (0.1.1 live)
- PA-006 — REVIEW (0.1.0 live)
- PA-015 — REVIEW (0.1.0 live)
- PA-001 … PA-005, PA-007, PA-008 — REVIEW (see ROADMAP remaining criteria)

## PA-006B findings

| Severity | Finding | Status |
|---|---|---|
| HIGH | Vanished member (crash / network loss, no `leave`) stayed a member forever: data link ICE stayed `disconnected`, PeerJS closes only on `failed`; blocked all later admissions and kept the last user from going idle (verified in Chromium: not removed after 145 s) | Fixed (D-024); removed after about 36 s in Chromium |
| HIGH | Cross-channel ordering: a newcomer's messages (chat, next `admit-propose`) that overtook the coordinator's commit were dropped; the next admission timed out after 45 s. Root cause of the 10-person e2e flake | Fixed (D-023); reproduced and covered by unit tests |
| MEDIUM | A proposal from a member that already counted the pending newcomer was refused `busy` by a member still connecting it | Fixed (deferred proposal, D-023) |
| MEDIUM | UI claimed "düşük veri modu açık" even if `setParameters` failed | Fixed (D-025) |
| LOW | Invite link remains in browser history / clipboard / shared places; not a secret | Documented |
| LOW | `SessionController` (~1200 lines) mixes admission, membership, link and media lifecycle | Not refactored; separate task proposed |
| — (no CRITICAL) | No path found where audio is sent to or played from a peer without the local user's own approval + commit | Verified by code review, unit and e2e tests |

## Last verified build (2026-11-25, macOS, Node 26.13.1)

- `npm audit`: 0 vulnerabilities; runtime dependencies: `peerjs@1.5.5` only
- `npm run typecheck`: pass
- `npm run build`: pass. Gzip 0.1.1 vs 0.1.0:
  - JS 40.15 KB (was 39.55, +0.60)
  - CSS 1.90 KB (unchanged)
  - HTML 2.61 KB (was 2.60)
  - Total about 44.66 KB (was about 44.05)
- No source maps; `noindex` + CSP present; `connect-src` = self + PeerJS Cloud only; no other URLs in the bundle.

## Last verified tests (2026-11-25)

- Unit (Vitest): **154 / 154 passed** (9 files; was 141: +13 in `groupStability.test.ts`).
  Before the fixes, 3 of the new tests failed (ordering race x2, bandwidth state); they pass now.
- Browser integration (Chromium, fake mic, real PeerJS Cloud): **13 tests** (was 12: + vanished peer).
  - 10-person test: **5 / 5 runs passed** (isolated runs).
  - Full dev suite: **3 / 3 runs, 13 / 13 each**.
  - Full production-preview suite: **2 / 2 runs, 13 / 13 each** (one before and one after the 0.1.1 version bump).
  - No failures in this task's runs. Earlier failure (PA-006, 1 of 7 runs) is explained by the ordering race; passing reruns alone
    would not prove that, the deterministic unit reproduction does.
- Measured outbound audio payload (getStats, synthetic beep, 5 runs): normal mode about 21.8–22.6 kbps per stream;
  low-bandwidth mode about 11.2–11.4 kbps per stream (cap 16 kbps). Human voice quality not verified.
- Vanished-peer detection (abrupt context close, Chromium): media "ses kesintide" after about 10 s, "ses yok" about 20 s, member
  removed about 36 s.
- GitHub Actions on `12be0f5`: deploy workflow **success**; browser-test workflow **13 / 13 passed** (CI measured: normal
  about 21.9 kbps, low-bandwidth about 11.4–11.5 kbps per stream; vanished peer removed after about 36 s).
- Live smoke test 0.1.1 (three Chromium contexts → live URL): **pass** — header `v0.1.1`, invite join, 3-person admission with
  both approvals, voice path connected, group chat, departures to idle. Live bundle hash equals local build (`index--2v7QKFz.js`).
- Manual tests for 0.1.x: **not run**.

## Manual test results

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
- 2026-11-25: Approved commit + push + deployment of 0.1.1.
- 2026-11-25: Started PA-006B (stability/privacy review); AGENTS.md (created by Codex) left untracked pending a user decision.
- 2026-11-25: Approved commit + push + deployment of 0.1.0.
- 2026-11-25: Approved PA-006 plan (Phase A). During implementation requested: max **10** participants (D-019),
  low-bandwidth mode above 5 (D-020), invite link button (D-021), compact layout and nicer level animation (D-022).

## Next recommended task

1. Manual tests: "Öncelikli 20 test" in MANUAL_TESTS.md (release gate).
2. **PA-011 before PA-009:** stability and membership convergence rank above usability in the project priorities; PA-006B showed
   that vanished peers, partial commits and lack of rejoin are the main remaining group risks. PA-009 (per-participant volume,
   device selection) is usability.
