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
