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

## D-004 — Full mesh, max 6 participants (2026-11-25) — **superseded by D-019 (max 10)**

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

## D-009 — Spike is 1:1; concurrent requests are rejected as busy (2026-11-25) — **superseded by D-016/D-017**

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

## D-016 — Group admission consent: every current member must approve (2026-11-25, PA-006)

A newcomer joins only after **each** current member explicitly accepts. Request acceptance (votes) and membership commit are
separate steps. Before commit the newcomer receives no audio (senders `replaceTrack(null)`, not given to the mic controller), no
playback of its stream, no chat history and no other members' UIDs (the member list is sent only after all approvals).
Each member enforces its **own** approval: it accepts the newcomer's mesh link and media offer only if it voted "accept" for that
admission itself, so a coordinator or candidate cannot approve on someone else's behalf. Votes are attributed to the authorized
link they arrive on. This does not solve D-011 (the coordinator's IP is still exposed to the requester before acceptance).

## D-017 — Admission coordinator, member-set snapshot, single admission (2026-11-25, PA-006)

- Coordinator = the member whose UID the candidate entered (deterministic, no election). It only aggregates votes/readiness and
  sends commit/abort; it never relays audio or chat and owns nothing after the admission.
- The proposal carries the coordinator's sorted member list; each member compares it with its own and votes `conflict` on mismatch.
  A snapshot is used instead of a revision counter because independent counters drift between peers.
- One admission at a time per peer (others get `busy`). Simultaneous admissions may abort each other; the candidate retries.
- Abort on any reject, vote timeout (45 s), mesh timeout (25 s), cancel, coordinator departure or membership change.
- The joining party always initiates data and media links ⇒ exactly one application DataConnection and one MediaConnection per pair.
- Limitation: membership is not atomic. If the coordinator crashes between commit messages, peers may disagree briefly; each shows
  its own honest state and new admissions stop (snapshot mismatch) until the views converge through departures. No automatic merge.

## D-018 — Protocol v2, explicit incompatibility with v1 (2026-11-25, PA-006)

Group messages need new fields; v1 (0.0.x) peers are rejected explicitly (a v1-formatted `join-reject` is sent so old clients
show an error; new clients show "farklı sürüm"). No mixed-version sessions.

## D-019 — Maximum 10 participants (2026-11-25, PA-006, user request) — supersedes D-004

User raised the limit from 6 to 10 (`MAX_PARTICIPANTS`). Full mesh: 45 pairs, 9 outbound and 9 inbound voice streams and
18 RTCPeerConnections per user. CPU/bandwidth impact is **not measured**; risk recorded for PA-014.

## D-020 — Low-bandwidth mode above 5 participants (2026-11-25, PA-006, user request)

When the group has more than `LOW_BANDWIDTH_THRESHOLD` (5) people, every outbound voice sender is capped to 16 kbps via
`RTCRtpSender.setParameters({ encodings: [{ maxBitrate }] })` (no renegotiation). At 5 or fewer the cap is removed (browser default
Opus bitrate). The UI shows "düşük veri modu". Opus at 16 kbps remains wideband speech; subjective quality not yet verified.

## D-021 — Invite links in the URL fragment (2026-11-25, PA-006, user request)

"Davet linkini kopyala" copies `…/psstamigo/#join=<uid>`. The fragment is never sent to GitHub Pages. Opening a link never connects
automatically: the user sees "İstek gönder / Vazgeç"; the normal admission (D-016) still applies. The fragment is removed from the
address bar after reading. Links expire with the inviter's tab (UID is temporary). Sharing a link = sharing a UID (D-011 applies).

## D-022 — Compact layout (2026-11-25, PA-006, user request)

User reported the 3-column card grid as hard to read. New layout: narrow sidebar (identity + invite, connect + requests) and one
session card (controls, participants, chat, collapsed "Teknik bağlantı bilgisi" with an explanation). Level meters changed from
rising "signal bars" to symmetric voice-wave bars, still driven only by the measured level. Single column on narrow screens.

## D-023 — Cross-channel ordering: keep early messages, defer proposals (2026-11-25, PA-006B)

**Finding (root cause of the 10-person e2e flake):** a newcomer commits as soon as the coordinator's `admit-commit` reaches it and
may immediately chat or coordinate the next admission. Its messages travel on a *different* channel than the coordinator's commit
to the other members, so they can arrive before that member's own commit and were silently dropped (lost chat; lost
`admit-propose` => the next admission waited 45 s and failed). A proposal from an older member that already counted the newcomer was
answered `busy` by a member still connecting the newcomer.
**Decision:** a member keeps up to 16 messages from a not-yet-committed candidate and processes them (with the usual checks) only
after its **own** commit; they are discarded on rollback, so nothing a rejected candidate sent is ever shown or acted on. The
candidate does the same for members' messages that overtake its commit. A proposal whose member set equals ours plus our pending
newcomer is deferred (one at a time) and judged after our admission commits or aborts. Authorization is unchanged: nothing is
accepted on another peer's word.

## D-024 — Detect vanished members via the data link's ICE state (2026-11-25, PA-006B)

**Finding:** when a tab ends without `pagehide` (crash, killed process, power/network loss), Chrome keeps the data connection in
ICE `disconnected` indefinitely and PeerJS only closes on `failed`; the peer stayed a member forever ("ghost"), blocked every later
admission (its vote never came) and kept the last remaining user from returning to idle.
**Decision:** a committed member whose application data link is ICE `failed`/`closed` is removed immediately; `disconnected` for
`TIMEOUTS.peerLostMs` (30 s) => removed. Recovery within 30 s cancels it. No heartbeat traffic is added. Background timer throttling
can only delay removal. Measured in Chromium: removed after about 36 s. Full reconnection remains PA-011.

## D-025 — Bandwidth mode reports failures honestly (2026-11-25, PA-006B)

`setParameters` results are collected; if the cap could not be applied to some sender the UI says
"düşük veri modu istendi ama bazı bağlantılarda uygulanamadı" instead of claiming success. Stale results of an older group-size
change are ignored (generation counter).

## D-026 — Version 0.1.1 (2026-11-25, PA-006B)

0.1.0 is already deployed; the PA-006B fixes change runtime behavior (member liveness, ordering, UI text), so the patch version is
bumped so testers can tell builds apart. Protocol stays v2 (compatible with 0.1.0).
