# Project status

| Field | Value |
|---|---|
| Current version | 0.0.1 |
| Current branch | `main` (pushed to `origin`) |
| Remote | `git@github.com:Bisbiliroglu/psstamigo.git` (public) |
| Live site | https://bisbiliroglu.github.io/psstamigo/ (GitHub Pages, Actions source, HTTPS enforced) |
| Current task | PA-001 — Project initialization and technical feasibility spike |
| Task status | REVIEW (awaiting user review and manual tests) |
| Last update | 2026-11-25 |

## Completed tasks

- none yet accepted by the user

## In progress

- PA-001 — REVIEW

## Pending

PA-002 … PA-016 (see [ROADMAP.md](ROADMAP.md))

## Last verified build (2026-11-25, macOS, Node 26.13.1, npm 11.20.0)

- `npm run typecheck` → pass (strict; `tsconfig.json` for src, `tsconfig.node.json` for tests/config)
- `vite build` → pass. `index.html` 2.12 KB, CSS 1.56 KB, JS 34.62 KB (gzip). CSP + noindex present in `dist/index.html`.

## Last verified tests (2026-11-25)

- Unit (Vitest 5.1.1): **73 / 73 passed** (5 files)
- Browser integration (Playwright 1.65.1, Chromium, fake mic, real PeerJS Cloud): **7 / 7 passed**, 3 consecutive runs + 1 final run
- GitHub Actions deploy run (typecheck, unit tests, build, deploy): **pass**
- Live-site smoke test (Playwright, two Chromium contexts on one machine → `bisbiliroglu.github.io/psstamigo/`): **pass** — signaling online, request/accept, voice path connected, chat delivered, 0 console errors, CSP served
- Manual / real network: **not run** (requires the user; see below)

## Manual test results

| Scenario (TEST_PLAN §3) | Result |
|---|---|
| 3.1 Same computer, two windows (Chrome/Edge, real mic) | NOT RUN |
| 3.2 Two computers, same LAN | NOT RUN |
| 3.3 Two computers, different ISPs | NOT RUN |
| 3.4 Home internet ↔ mobile hotspot | NOT RUN |
| 3.5 Hotspot ↔ hotspot | NOT RUN |
| 3.6 In-game background, 15+ min | NOT RUN |
| 3.7 Tab close during call | NOT RUN |

## Known issues

- 1:1 only. Incoming requests during a session (or while requesting) are rejected as `busy`; simultaneous mutual requests both fail.
- No TURN: some NAT/CGNAT combinations (common on mobile networks) will not connect; the user sees an error.
- Signaling loss: one bounded reconnect attempt only; full recovery is PA-011.
- Speaking-indicator thresholds are untuned for real voices (fake device only).
- Display name is not persisted (by design for now); it is sent only inside the join request/accept.
- Diagnostics panel is basic and Turkish/English mixed in raw state values.

## Technical debt

- Reading the incoming offer SDP relies on PeerJS internal `options._payload` (guarded; falls back to post-answer video track rejection).
- `SessionController` contains 1:1 assumptions that PA-006 must generalize.
- E2E tests depend on the public PeerJS Cloud (network flakiness possible).
- Bundled `webrtc-adapter` contains unused `getDisplayMedia` shim code (never called; verified in e2e).

## User decisions

- 2026-11-25: Project name PsstAmigo (was TalkyWalky); repo `psstamigo`; task prefix PA.
- 2026-11-25: Approved Phase 1 recommendations — STUN only (PeerJS default TURN disabled), approach A (D-002).
- 2026-11-25: Public GitHub repo created by the user; leak prevention requested (noreply identity, no personal data).
- 2026-11-25: Approved initial commit, push and GitHub Pages enablement.

## Next recommended task

Site is live, so the user can now run manual tests 3.1–3.7 with friends over real networks.
Then **PA-006 — P2P mesh group sessions (max 6)**. PA-015 (deployment) is effectively done for the spike; release
hardening stays in PA-015/PA-016.
