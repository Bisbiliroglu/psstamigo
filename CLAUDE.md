# CLAUDE.md — PsstAmigo development rules

Read this file, `docs/PROJECT_STATUS.md` and the docs relevant to the task at the start of every session.

## Project

PsstAmigo is a lightweight, privacy-focused, peer-to-peer **voice and text** app for friends who play games together.
No accounts, no cameras, no screen sharing, no recordings. Static site on GitHub Pages, signaling via PeerJS Cloud.
Motto: *Connect. Talk. Play.*  Task IDs: `PA-001`, `PA-002`, …

## Priorities (higher wins on conflict)

1. Privacy & security 2. Connection stability 3. Audio quality 4. Low latency 5. Low resource use 6. Usability 7. Visuals

## Non-negotiable privacy rules (apply to every line of code)

- **PRIV-001** Never request the microphone on load, on UID creation, on receiving/accepting a request, or on joining. Mic is off by default and only enabled by an explicit user click.
- **PRIV-002** Mic off = `replaceTrack(null)` on every sender + `track.stop()` + analyser disconnected + indicator reset. `track.enabled = false` alone is NOT acceptable. Re-enable = new `getUserMedia`.
- **PRIV-003** Speaker off by default. No playback until the user enables it. New participants / reconnects never turn it on.
- **PRIV-004** Idempotent cleanup on leave, session end, fatal error and `pagehide`. Peer is destroyed on page termination. BFCache restore (`pageshow.persisted`) reloads the page.
- **PRIV-005** `visibilitychange` / `blur` must never end a call.
- **PRIV-006** Every async media operation is generation-checked; stale results stop their tracks immediately.
- **PRIV-007** Reconnection never re-enables mic or speaker.
- **PRIV-008** No camera, no video, no screen/desktop/system audio capture. `getUserMedia` is audio-only (`video: false`). Never use `getDisplayMedia`. Video offers/tracks are rejected.
- **PRIV-009** No recording: no `MediaRecorder`, no audio files, no audio in storage, no audio to external services.
- **PRIV-010** No analytics, telemetry, tracking cookies, fingerprinting, ads, crash reporting, external fonts/CDNs. Dependencies are bundled.
- **GROUP (D-016)** A newcomer needs every member's own approval; audio/playback/history only after commit; each member enforces its own approval.
- **ORDERING (D-023)** Never act on a not-yet-committed peer's messages; buffer (bounded) until own commit, drop on rollback.
- **PRIV-011** A UID grants nothing. Media only after explicit acceptance. All protocol messages are untrusted: schema-validated, size-limited, rate-limited. Render remote text with `textContent` only.
- **PRIV-012** Never overstate security. WebRTC transport encryption ≠ authenticated end-to-end identity.

`tests/unit/policy.test.ts` enforces part of this statically. Do not weaken it.

## Technology constraints

- TypeScript (strict), Vanilla TS, HTML/CSS, Vite, Vitest, Playwright. Runtime dependency: `peerjs` only.
- No React/Vue/Angular/Tailwind. No new runtime dependency without user approval.
- No backend, database, Firebase/Supabase/AWS/Azure/GCP/Cloudflare, no paid services, no secrets in code.
- ICE: public STUN only. PeerJS's built-in TURN default is deliberately disabled (DECISIONS D-003). Do not add TURN or any new external service without user approval.
- PeerJS is imported **only** in `src/signaling/PeerJsSignaling.ts`. UI never manages connection lifecycle.

## Explicitly out of scope

Camera, video, screen sharing, system audio, recording, accounts, persistent identity, persistent chat, file sharing, public user directory, analytics, ads, backend, database.
Group size: `MAX_PARTICIPANTS` = 10 (D-019); low-bandwidth mode above 5 (D-020); invite links in the URL fragment only (D-021).
Deferred (only on explicit request): shared access key, global hotkeys, push-to-talk, friend list, desktop packaging, PWA. Do not build placeholders for these.

## Workflow

1. Read CLAUDE.md + relevant docs, check `git status`, preserve user changes.
2. Work only within the approved task. No unrelated refactors, no unnecessary dependencies.
3. Ask before large architectural changes or stack changes.
4. Run `npm run typecheck`, `npm test`, `npm run build`, and `npm run test:e2e` when relevant. Report real results only.
5. Update `docs/PROJECT_STATUS.md` (and ROADMAP / DECISIONS / CHANGELOG when relevant).
6. Prepare manual test steps; keep real-device/network tests separate from automated ones and never mark them PASS without user confirmation.
7. Report in the task completion format (see `docs/PROJECT_STATUS.md`), propose the next task, then **STOP**.

Without explicit user approval: no next task, no commit, no push, no release, no GitHub Pages deployment, no bulk deletion, no stack change.

## Public repository hygiene

The repo is public. Never commit personal data, absolute local paths, e-mail addresses, tokens or `.env` files.
Commits use the repository-local GitHub `noreply` identity.

## Language

Code, identifiers, tests and technical docs: English. Explanations to the user: Turkish (English technical terms are fine). UI text: Turkish.

## Commands

```
npm run dev        # http://localhost:5173/psstamigo/
npm run typecheck
npm test           # unit tests (Vitest)
npm run test:e2e   # browser tests (Playwright, needs internet: PeerJS Cloud)
npm run test:e2e:preview  # browser tests against the production build (CSP)
npm run build      # typecheck + production build to dist/
```
