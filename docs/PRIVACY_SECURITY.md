# Privacy & Security

Privacy requirements are mandatory, not optional features. They apply to every task, including prototypes.

## Requirements and how they are met (0.0.1)

| ID | Requirement | Implementation | Verification |
|---|---|---|---|
| PRIV-001 | No automatic microphone access | `getUserMedia` is only called from the mic button handler; button disabled outside a session | e2e: `gum == 0` on load, after request, after accept |
| PRIV-002 | True microphone shutdown | `replaceTrack(null)` on all senders, `track.stop()`, analyser disposed, indicator reset; re-enable = new capture | unit + e2e: track `ended`, no sender track, outbound RTP packet count constant |
| PRIV-003 | No unauthorized playback | Players created only while speaker enabled; disabled ⇒ paused, `srcObject = null`, analysers disconnected | unit + e2e: `playing == 0`, indicator 0 |
| PRIV-004 | Complete lifecycle cleanup | Idempotent `SessionController.dispose`, `App.shutdown` on `pagehide`, BFCache restore reloads | unit (idempotency), e2e (reload, leave ⇒ all RTCPeerConnections closed) |
| PRIV-005 | Background operation | No handler for `visibilitychange`/`blur` | e2e (synthetic events); real game test manual |
| PRIV-006 | Fail-safe async | Generation counter in `MicrophoneController`; identity checks on every callback in `SessionController` | unit (disable/dispose during pending gUM), e2e (leave while mic starting) |
| PRIV-007 | Safe reconnection | Reconnect is signaling-only; session end resets mic & speaker to off | unit (sessionEnded hook); full engine PA-011 |
| PRIV-008 | No camera / screen | `video: false`; no `getDisplayMedia` in app code; video offers & tracks rejected | policy test, unit, e2e (`gdm == 0`, constraints) |
| PRIV-009 | No recording | No `MediaRecorder`, no storage APIs in app code | policy test |
| PRIV-010 | No tracking | No analytics, no external fonts/scripts; production CSP restricts connections to self + PeerJS Cloud | policy test, CSP in build |
| PRIV-011 | Connection authorization | Media only for the accepted participant; schema validation, 2 KB size limit, rate limit (20 msgs / 5 s), max 3 pending requests, handshake timeout | unit |
| PRIV-012 | Honest claims | This document; README limitations | review |

## Threat model

### Assets

Voice content, chat content, who talks to whom and when, IP addresses, the microphone itself.

### Trust boundaries

| Party | Sees | Cannot see |
|---|---|---|
| GitHub Pages | that someone loaded the static site (standard web server logs) | signaling, audio, chat |
| PeerJS Cloud (`0.peerjs.com`) | UIDs, IP addresses, connection timing, SDP/ICE (incl. candidate IPs), PeerJS connection metadata | audio, chat (encrypted P2P) |
| Google STUN | public IP and port | anything else |
| Other participants | your public IP (P2P), your display name, your voice/chat when you send it | your mic when it is off |
| Network observers | encrypted traffic, endpoints | content |

### Threats and mitigations

| Threat | Mitigation | Residual risk |
|---|---|---|
| Stranger guesses / learns a UID and calls | UID ≈ 59 bits random; every request needs explicit acceptance; no global directory | A known UID can still send request spam ⇒ rate/pending limits |
| Unaccepted peer sends a media offer | Closed unanswered unless from the accepted participant | — |
| Malicious peer sends malformed / huge / HTML messages | Strict schema, size limit, rate limit, `textContent` rendering, bidi/control char stripping | — |
| Video offer to obtain camera | `video: false` always; video offers/tracks rejected | — |
| Mic stays live after "off" | `stop()` + `replaceTrack(null)` + generation checks; e2e checks RTP stops | Browser/OS bugs are out of our control |
| Signaling server impersonation (MITM) | WebRTC DTLS fingerprints come via signaling, so a malicious signaling server could MITM | **Not mitigated.** No authenticated end-to-end identity verification. |
| Third-party code (PeerJS, webrtc-adapter) | Pinned exact versions, lock file, bundled (no CDN), only PeerJS module imports it | Supply-chain trust remains |
| XSS via build or dependencies | CSP `script-src 'self'`, no inline scripts in build, no `innerHTML` | Meta CSP cannot set `frame-ancestors` (GitHub Pages has no custom headers) |

### Known limitations (must stay documented)

- PeerJS Cloud signaling can see connection metadata.
- Public STUN services can see connection metadata (public IP).
- P2P participants learn each other's public IP addresses.
- A UID is not identity verification.
- Trust in the signaling infrastructure is not eliminated.
- The GitHub Pages site is reachable by anyone on the internet; `noindex` is not access control. The public repository is indexable.
- Behavior of the browser, OS, and other applications (including recording by other participants) cannot be controlled.
- Without TURN, some NAT/CGNAT combinations cannot connect.
- If the page is killed without lifecycle events, the browser still tears down capture and connections, but the UID may linger on
  PeerJS Cloud until its server-side timeout (not documented for the cloud; ~60 s default for self-hosted PeerServer).

### Third-party code notes

- The bundled `webrtc-adapter` (PeerJS dependency) contains `getDisplayMedia` shim code. The app never calls it; the policy test
  covers app sources and the e2e test asserts it is never invoked.
- PeerJS contains a built-in default TURN configuration (`*.turn.peerjs.com`). The app passes an explicit STUN-only
  configuration, which replaces it (D-003).

## Privacy acceptance criteria (every release)

- [ ] First load: no permission prompt; `getUserMedia` not called.
- [ ] Joining/accepting: mic and speaker remain off.
- [ ] Mic off: browser recording indicator disappears; no outbound audio RTP.
- [ ] Speaker off: no playback; indicator 0.
- [ ] Leave / reload / close: no capture, no playback, no peer connections remain.
- [ ] No camera / screen permission is ever requested.
- [ ] `npm test` policy checks pass.
