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
| `src/session` | protocol validation, session state machine, authorization, media setup | core, signaling **interfaces**, messaging |
| `src/audio` | AudioContext, mic lifecycle, speaker lifecycle, level meters | core |
| `src/messaging` | ephemeral chat log | core |
| `src/ui` | DOM rendering of snapshots; emits user actions | type-only imports |
| `src/app` | composition root, browser lifecycle, diagnostics | everything |

`SessionController` talks to audio only through `SessionMediaHooks` (dependency inversion), which keeps it unit-testable
with fakes and keeps Web Audio out of the session layer.

## Session state machine (spike, 1:1)

```
            requestJoin(uid)                join-accept
   idle ───────────────────► requesting ─────────────────► active
    ▲  ▲                        │ reject / timeout /            │ leave / remote leave /
    │  └────────────────────────┘ unavailable / cancel          │ data channel closed
    │                                                           │
    │   incoming join-request → pending list (no media)         │
    │   acceptRequest(id) ─────────────────────────────────────►│
    └────────────────────────── endSession() ◄──────────────────┘
                                (mic off, speaker off, chat cleared, AudioContext closed)
```

Incoming requests while `requesting` or `active` are rejected as `busy` (group support comes in PA-006).

## Connection lifecycle

1. **Signaling**: `new Peer(uid, { config: { iceServers: STUN only } })`. On `unavailable-id` a new UID is generated (max 3 tries).
   After registration, signaling errors never destroy existing P2P links; one bounded reconnect is attempted.
2. **Request**: requester opens a `DataConnection` (`serialization: "json"`, reliable) and sends `join-request`.
3. **Authorization**: target shows the request. Nothing else happens until the user clicks.
4. **Accept**: target sends `join-accept`. Both sides now treat each other as participants.
5. **Media**: the requester calls `peer.call(target, silentStream)`; the target answers only if the caller is the accepted
   participant, there is no existing call, and the offer has no video m-line.
6. **Mic attach**: each side hands its audio `RTCRtpSender` to `MicrophoneController`, which immediately sets
   `replaceTrack(null)` (mic off) or the live track (mic on). The synthetic silent track is stopped.
7. **Remote audio**: the remote stream goes to `SpeakerController`, which plays it only when the speaker is enabled.

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

## Error handling

- All user-visible errors are Turkish plain-text notices; no failed state is shown as success.
- Timeouts: signaling 15 s, data channel open 15 s, answer 45 s, incoming request 45 s, media setup 20 s.
- Media failure on an otherwise working session marks the participant `ses yok` and stops sending/playing for that peer.
- No infinite retries anywhere.
