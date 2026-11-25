# Project status

| Field | Value |
|---|---|
| Current version | 0.0.2 (deployed as test build) |
| Current branch | `main` = `origin/main` (0.0.2 review commit `a528d23` + this status update) |
| Remote | `git@github.com:Bisbiliroglu/psstamigo.git` (public) |
| Test deployment | https://bisbiliroglu.github.io/psstamigo/ (GitHub Pages, Actions source, HTTPS enforced) |
| Current task | PA-015 — PA-001 review & GitHub Pages **test** deployment (brought forward, D-015) |
| Task status | Phase E done (0.0.2 deployed and verified live); Phase F: manual tests by the user pending |
| Last update | 2026-11-25 |

## Completed tasks

- none accepted as DONE yet (PA-001 stays in REVIEW until manual/real-network tests pass)

## In progress

- PA-015 — REVIEW (0.0.2 test deployment live; awaiting manual test results)
- PA-001 — REVIEW

## Pending

PA-002 … PA-005, PA-007, PA-008: REVIEW* (core covered by spike, remaining criteria in [ROADMAP.md](ROADMAP.md)).
PA-006, PA-009 … PA-014, PA-016: TODO.

## Last verified build (2026-11-25, macOS, Node 26.13.1, npm 11.20.0, clean `npm ci`)

- `npm audit`: 0 vulnerabilities (runtime: `peerjs@1.5.5` + 5 transitive packages)
- `npm run typecheck`: pass
- `vite build`: pass. Gzip sizes 0.0.2 vs 0.0.1:
  - JS 35.17 KB (was 34.62, +0.55)
  - CSS 1.58 KB (was 1.56, +0.02)
  - HTML 2.11 KB (was 2.12)
  - Total ≈ 38.86 KB (was ≈ 38.30)
- Production build: no source maps, no robots.txt/sitemap, `noindex` + CSP present, asset paths under `/psstamigo/`.

## Last verified tests (2026-11-25)

- Unit (Vitest): **100 / 100 passed** (6 files; was 73: +27 regression tests for review findings)
- Browser integration, dev server: **8 / 8 passed** (was 7: +1 framed-page test; main flow gained CSP and STUN-only assertions)
- Browser integration, production build with CSP (`vite preview`): **8 / 8 passed**
- CSP negative check on production build: inline script blocked, fetch to another origin blocked
  (eval blocking cannot be observed via DevTools-evaluated code; policy contains no `unsafe-eval`)
- GitHub Actions on `a528d23`: deploy workflow (build + privacy checks + deploy) **success**; browser-test workflow **8 / 8 passed**
- Live site 0.0.2 smoke test (two Chromium contexts → https://bisbiliroglu.github.io/psstamigo/): **pass** — header `v0.0.2`,
  signaling online, request/accept, voice path connected, chat delivered, mic on/off, leave. Live bundle hash equals local build
  (`index-Cu-cQLDa.js`); `noindex` and CSP served.
- Manual / real network: **not run**

## Manual test results

Checklist: [MANUAL_TESTS.md](MANUAL_TESTS.md). All scenarios: **NOT RUN**.

| Area | IDs | Result |
|---|---|---|
| Network | N-01 … N-05 | NOT RUN |
| Functional | B-01 … B-13 | NOT RUN |
| Privacy | P-01 … P-12 | NOT RUN |
| Gaming (Chrome & Edge, Windows) | G-01 … G-07 | NOT RUN |

## Known issues

- 1:1 only; requests during a session are rejected as `busy`; simultaneous mutual requests both fail (D-009).
- No TURN: some NAT/CGNAT (esp. mobile) combinations cannot connect; an error is shown.
- **A requester learns the target's public IP before acceptance** (PeerJS auto-negotiates data connections; D-011).
- Signaling loss: one bounded reconnect only (PA-011).
- Remote tab crash/kill may take up to ~30 s to be detected (data channel / ICE timeout).
- Speaking-indicator thresholds untuned for real voices.

## Technical debt

- Offer audit relies on PeerJS internal `options._payload` (now fail-closed; a PeerJS change breaks calls safely, D-010).
- `SessionController` 1:1 assumptions to generalize in PA-006.
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

## Next recommended task

1. User runs [MANUAL_TESTS.md](MANUAL_TESTS.md) with friends; results recorded here.
2. Then **PA-006 — P2P mesh group sessions (max 6)**.
