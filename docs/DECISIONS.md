# Decisions

Superseded decisions are kept and marked; never delete history.

## D-001 — Project name and identifiers (2026-11-25)

The initial brief used the name "TalkyWalky". The user renamed the project to **PsstAmigo**.
Repository `psstamigo`, Pages path `/psstamigo/`, task IDs `PA-xxx` (instead of `TW-xxx`), UID prefix `psst-`.

## D-002 — Audio path via PeerJS MediaConnection + replaceTrack (2026-11-25)

**Context:** PeerJS 1.5.5 `call()` requires a stream and has no renegotiation support. Privacy requires the call to exist
without the microphone, and the mic to be fully stopped/started during the call.

**Decision (approach A):** Create the call with a synthetic silent stream (`MediaStreamAudioDestinationNode`, never a microphone),
then control the sender with `RTCRtpSender.replaceTrack(track | null)`. The silent track is stopped right after setup.

**Alternative (approach B, fallback):** Use PeerJS only for signaling + DataConnection and manage our own `RTCPeerConnection`
negotiated over the DataChannel. More control (transceivers, codec preferences), more code. Revisit if A fails a requirement.

**Verified in spike:** e2e shows mic tracks ended and no sender track after mic off, and outbound audio RTP packets stop.

## D-003 — STUN only; PeerJS default TURN disabled (2026-11-25)

**Context:** PeerJS ships an undocumented default TURN server (`eu-0/us-0.turn.peerjs.com`, shared static credentials).
Its operator, terms and limits are not documented. The brief forbids unverified public TURN services and new external services
without approval.

**Decision:** Pass an explicit `iceServers` with only `stun:stun.l.google.com:19302`, which replaces PeerJS defaults.
Connections that need a relay fail with a clear error. User approved this recommendation.

## D-004 — Full mesh, max 6 participants (2026-11-25)

Per the brief. Each participant keeps one data + one media connection per other participant (max 5 each).
Re-evaluate after performance tests (PA-014).

## D-005 — Single runtime dependency, exact pinned versions (2026-11-25)

Runtime: `peerjs@1.5.5`. Dev: `typescript@7.0.2`, `vite@8.3.8`, `vitest@5.1.1`, `@playwright/test@1.65.1`, `@types/node@26.6.10`.
All pinned exactly with `package-lock.json`. No UI framework, no lint toolchain for now (policy checks are plain Vitest tests).

## D-006 — DataConnection serialization JSON (2026-11-25)

Outgoing data connections use `serialization: "json"` (simpler and safer to validate than binary packing). Inbound payloads
are validated regardless of the serializer the remote side chose.

## D-007 — Production-only meta CSP (2026-11-25)

GitHub Pages cannot send headers, so a `<meta http-equiv="Content-Security-Policy">` is injected at build time. The dev server is
excluded because Vite's dev client needs inline scripts and HMR websockets.

## D-008 — Public repo identity hygiene (2026-11-25)

Commits use the repository-local GitHub `noreply` e-mail and the GitHub username, not the personal e-mail or full name.
LICENSE copyright holder: "PsstAmigo contributors".

## D-009 — Spike is 1:1; concurrent requests are rejected as busy (2026-11-25)

While requesting or in a session, incoming requests are rejected with `busy`. Two users requesting each other simultaneously
both get `busy`; one retries. Group join flow is designed in PA-006.

## D-010 — Fail-closed media offer audit (2026-11-25, PA-015 review)

**Finding:** The PA-001 check `offerHasVideo` read PeerJS's non-public `options._payload` and treated an unreadable SDP as
"no video" (fail-open).
**Decision:** `signaling/sdpPolicy.ts` returns `audio-only | video | unreadable | invalid`; only `audio-only` is answered.
Allowed: exactly one `audio` section plus at most one `application … webrtc-datachannel` section (PeerJS 1.5.5 adds this internal
data channel to every media connection — observed in real offers). Remote video tracks are still rejected after answering.
If PeerJS changes its internals, calls fail safely and e2e tests fail. Alternative if that happens: approach B (D-002).

## D-011 — IP address exposure before acceptance is accepted and documented (2026-11-25, PA-015 review)

PeerJS automatically negotiates every incoming data connection (ICE runs before the user accepts), so anyone who knows a UID can
learn the target's public IP address. No audio, chat or display name of the target is shared before acceptance.
Avoiding this would require relaying the request through signaling without a peer connection, which PeerJS Cloud does not offer
(would need a custom signaling server — excluded by infrastructure constraints). Documented in README and PRIVACY_SECURITY.md.

## D-012 — Refuse to run inside frames (2026-11-25, PA-015 review)

`frame-ancestors` cannot be set via meta CSP and GitHub Pages cannot send `X-Frame-Options`. An embedding page could grant
microphone permission to the frame and trick the user into clicking. The app shows a notice and does not start when framed.

## D-013 — CI: deploy gate vs. browser tests (2026-11-25)

Deploy workflow gates on type check, unit tests (incl. policy tests), production build and a production privacy check
(noindex, CSP, no robots.txt/sitemap, no source maps). Browser tests run in a separate workflow (`browser-tests.yml`) because they
depend on the public PeerJS Cloud; they are not retried and their result is reported separately. Only official GitHub actions;
least-privilege permissions per job.

## D-014 — Version 0.0.2 (2026-11-25)

Security/privacy fixes from the PA-015 review change runtime behavior (offer audit, frame refusal, UI status). Bumped to `0.0.2`
so testers can tell builds apart (version is shown in the header). No tag, no release.

## D-015 — PA-015 brought forward as a test deployment; roadmap reorder approved (2026-11-25)

The user approved the roadmap reordering proposed in PA-001 and moved PA-015 (GitHub Pages) before group sessions, **for testing
only**. This is not a stable release and does not complete PA-001; real-device/network acceptance is still pending.
PA-002…PA-005, PA-007, PA-008 are not marked DONE automatically.
