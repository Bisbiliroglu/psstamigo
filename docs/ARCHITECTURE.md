# Architecture

## Overview

```
 Browser A                                     Browser B
 ┌─────────────────────────┐                   ┌─────────────────────────┐
 │ UI (View)               │                   │ UI (View)               │
 │   ▲ snapshots  │ actions│                   │                         │
 │ App (lifecycle wiring)  │                   │ App                     │
 │ ├ SessionController ────┼── DataChannel ────┼─ SessionController      │
 │ ├ MicrophoneController ─┼── RTP (Opus) ─────┼─ SpeakerController      │
 │ ├ SpeakerController     │                   │                         │
 │ └ PeerJsSignaling ──────┼──┐             ┌──┼─ PeerJsSignaling        │
 └─────────────────────────┘  │  WebSocket  │  └─────────────────────────┘
                              ▼             ▼
                    PeerJS Cloud (0.peerjs.com)   ← signaling only (SDP/ICE)
                    Google STUN                    ← public address discovery
 GitHub Pages: serves static files only. No audio or messages pass through it.
```

## Modules and dependency boundaries

| Module | Responsibility | May depend on |
|---|---|---|
| `src/core` | config, UID, emitter, rate limiter | — |
| `src/signaling` | **only place that imports PeerJS**; wraps Peer / DataConnection / MediaConnection into `Signaling`, `DataLink`, `MediaLink` interfaces | core |
| `src/session` | protocol v2 validation, group membership/admission (`admission.ts` helpers), authorization, media setup, bandwidth mode | core, signaling **interfaces**, messaging |
| `src/audio` | AudioContext, mic lifecycle, speaker lifecycle, level meters | core |
| `src/messaging` | ephemeral chat log | core |
| `src/ui` | DOM rendering of snapshots; emits user actions | type-only imports |
| `src/app` | composition root, browser lifecycle, diagnostics | everything |

`SessionController` talks to audio only through `SessionMediaHooks` (dependency inversion), which keeps it unit-testable
with fakes and keeps Web Audio out of the session layer.

## Session state machine (group, PA-006)

> Replaces the 1:1 spike machine (requesting/active with `busy` for every other request, D-009). Each peer runs it locally.

```
idle ──requestJoin──► requesting(contacting → approval → connecting) ──admit-commit──► active
  ▲                          │ reject / abort / timeout / cancel / coordinator gone              │
  └──────────────────────────┘                                                                    │
idle ──join-request arrives──► (admission, me = coordinator, member set = {me}) ──commit──► active
active ──leave / last member gone──► idle (mic off, speaker off, chat cleared, AudioContext closed)

admission inside a peer:  none → voting → connecting → (commit | abort) → none   (one at a time)
```

## Group admission (D-016, D-017)

```
 C (candidate)            B (coordinator = UID C entered)            A (member)
   │── join-request ──────►│ capacity / busy / duplicate checks          │
   │◄── join-pending ──────│── admit-propose{sid,aid,C,name,members} ───►│ own link? same sid? same member set?
   │                       │   (B's user votes)                          │ (A's user votes)
   │                       │◄── admit-vote{aid,accept} ──────────────────│ (only on A–B link)
   │◄── join-accept{members}── all accepted                              │
   │═ data link + mesh-hello ═══════════════════════════════════════════►│ accept only with A's OWN approval
   │◄═════════════════════════════════════════════════════ mesh-ack ═════│
   │═ silent call (C initiates) ════════════════════════════════════════►│ audio-only audit (D-010)
   │═ silent call ════════►│                                             │
   │                       │◄── admit-ready (A–C data+ICE up) ───────────│
   │◄── admit-commit ──────│── admit-commit ────────────────────────────►│
   commit on every peer: sender → mic controller (live only if mic is on), stream → speaker (plays only if on)
```

Ordering across channels (D-023): commit messages and the newcomer's first messages use different links. A member keeps the
candidate's early messages (max 16) until its own commit and drops them on rollback; a newcomer keeps members' early messages until
its commit; a proposal that already counts our pending newcomer is deferred until our admission finishes.

Liveness (D-024): committed members are watched through their data link's ICE state: `failed`/`closed` => removed,
`disconnected` for 30 s => removed (crashed tabs never send `leave`).

Abort paths: any `declined/busy/conflict/full` vote, vote timeout 45 s, mesh timeout 25 s (+8 s local slack on members and
candidate), candidate cancel/disconnect, coordinator departure, any membership change, invalid/video/unreadable offer.
Rollback closes only the candidate's links; the existing session is untouched.

## Connection lifecycle

1. **Signaling**: `new Peer(uid, { config: { iceServers: STUN only } })`. On `unavailable-id` a new UID is generated (max 3 tries).
   After registration, signaling errors never destroy existing P2P links; one bounded reconnect is attempted.
2. **Request**: requester opens a `DataConnection` (`serialization: "json"`, reliable) and sends `join-request`.
3. **Authorization**: target shows the request. Nothing else happens until the user clicks.
4. **Accept**: target sends `join-accept`. Both sides now treat each other as participants.
5. **Media**: the joining party calls `peer.call(member, silentStream)`; a member answers only if the caller is the candidate of an
   admission it approved itself, there is no existing call, and the fail-closed offer audit (`signaling/sdpPolicy.ts`, D-010)
   returns `audio-only`. Unreadable, invalid or video offers abort the admission.
6. **Mic attach (only at commit)**: before commit the sender is `replaceTrack(null)`; at commit it is handed to
   `MicrophoneController`, which applies the live track only if the mic is on at that moment. The silent track is stopped.
   Low-bandwidth mode (D-020) adjusts every member sender's `maxBitrate` when the group size crosses 5.
7. **Remote audio (only at commit)**: the stream is kept on the link and given to `SpeakerController` at commit; it plays only when
   the speaker is enabled. Media failure of a member ≠ departure (chat continues); a closed data link = departure.

### Why a synthetic silent stream? (D-002)

PeerJS 1.5.5 requires a `MediaStream` for `call()`/`answer()` and has no renegotiation. Calling with a
`MediaStreamAudioDestinationNode` stream (not a microphone) creates a `sendrecv` audio transceiver. Afterwards the
real microphone is attached/detached with `RTCRtpSender.replaceTrack()`, which needs no renegotiation. With
`replaceTrack(null)` no RTP is sent (verified in e2e: outbound packet count stays constant).

## Audio lifecycle

- `AudioGraph` owns one `AudioContext`, created lazily on user-gesture paths, closed when a session ends and on shutdown.
- `MicrophoneController`: `off → starting → on → off` (or `error`). Each `enable()` has a generation number; a late
  `getUserMedia` result is stopped immediately. `disable()` = `replaceTrack(null)` on all senders + `track.stop()` + meter disposal.
- `SpeakerController`: one `HTMLAudioElement` per remote stream, created only when the speaker is on; on disable the element is
  paused, `srcObject` cleared and analysers disconnected.
- `MeterLoop`: a single `requestAnimationFrame` loop (~15 fps) that runs only while a meter is active. It pauses automatically in
  background tabs, so indicators cost nothing while gaming.

## Browser lifecycle

| Event | Behavior |
|---|---|
| `pagehide` (close, reload, navigation, BFCache entry) | `App.shutdown()`: session dispose, mic/speaker dispose, AudioContext close, `peer.destroy()`. Idempotent. |
| `pageshow` with `persisted` | `location.reload()` → fresh UID, no old state. |
| `visibilitychange`, `blur` | ignored (call continues). |

If no lifecycle event runs (crash, kill), the browser itself ends capture and peer connections with the document.
The remote side detects the closed data channel; the UID stays on PeerJS Cloud until its server-side timeout.

## Data flow

- Signaling (SDP, ICE candidates, UIDs): WebSocket to PeerJS Cloud.
- Control & chat: WebRTC DataChannel (DTLS), JSON, validated by `session/protocol.ts`.
- Voice: WebRTC SRTP (DTLS-SRTP), Opus (browser default).
- Diagnostics: local `getStats()` only, polled every 2 s and only while the diagnostics panel is open.

## Media status shown in the UI

`connecting` (setup window, 20 s) → `connected` (ICE connected/completed) ⇄ `interrupted` (ICE disconnected, shown as
"ses kesintide…") → `failed` (ICE failed, timeout, rejected offer, media closed). The UI never shows "connected" while ICE is
disconnected. A new authorized call after a failure starts a fresh setup window.

## Invite links (D-021)

`core/invite.ts` builds/parses `#join=<uid>`; `App` reads it once, removes it from the address bar and shows a confirmation banner.
The request is sent only when the user clicks "İstek gönder".

## Startup guard

`main.ts` refuses to start the app when the page is inside a frame (D-012): no signaling, no UID, no media.

## CI / deployment

- `.github/workflows/deploy.yml`: `npm ci` → type check → unit tests → `vite build` → production privacy check → Pages artifact → deploy.
- `.github/workflows/browser-tests.yml`: Playwright e2e against the dev server (separate, not gating deploy).
- Locally: `npm run test:e2e:preview` runs the e2e suite against the production build (with CSP) via `vite preview`.

## Error handling

- All user-visible errors are Turkish plain-text notices; no failed state is shown as success.
- Timeouts: signaling 15 s, data channel open 15 s, answer 45 s, incoming request 45 s, media setup 20 s.
- Media failure on an otherwise working session marks the participant `ses yok` and stops sending/playing for that peer.
- No infinite retries anywhere.
