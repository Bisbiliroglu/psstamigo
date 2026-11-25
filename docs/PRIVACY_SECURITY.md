# Privacy & Security

Privacy requirements are mandatory, not optional features. They apply to every task, including prototypes.

## Requirements and how they are met (0.1.0, group)

| ID | Requirement | Implementation | Verification |
|---|---|---|---|
| PRIV-001 | No automatic microphone access | `getUserMedia` is only called from the mic button handler; button disabled outside a session | e2e: `gum == 0` on load, after request, after accept |
| PRIV-002 | True microphone shutdown | `replaceTrack(null)` on all senders, `track.stop()`, analyser disposed, indicator reset; re-enable = new capture | unit + e2e: track `ended`, no sender track, outbound RTP packet count constant |
| PRIV-003 | No unauthorized playback | Players created only while speaker enabled; disabled ⇒ paused, `srcObject = null`, analysers disconnected | unit + e2e: `playing == 0`, indicator 0 |
| PRIV-004 | Complete lifecycle cleanup | Idempotent `SessionController.dispose`, `App.shutdown` on `pagehide`, BFCache restore reloads | unit (idempotency), e2e (reload, leave ⇒ all RTCPeerConnections closed) |
| PRIV-005 | Background operation | No handler for `visibilitychange`/`blur` | e2e (synthetic events); real game test manual |
| PRIV-006 | Fail-safe async | Generation counter in `MicrophoneController`; identity checks on every callback in `SessionController` | unit (disable/dispose during pending gUM), e2e (leave while mic starting) |
| PRIV-007 | Safe reconnection | Reconnect is signaling-only; session end resets mic & speaker to off | unit (sessionEnded hook); full engine PA-011 |
| PRIV-008 | No camera / screen | `video: false`; no `getDisplayMedia` in app code; incoming offers pass a **fail-closed** SDP audit (`signaling/sdpPolicy.ts`): only exactly one audio section (+ at most PeerJS's one internal data channel) is answered; video, unreadable, invalid offers are closed unanswered; video tracks are rejected again after answering | policy test, unit (`sdpPolicy.test.ts`, session), e2e (`gdm == 0`, constraints) |
| PRIV-009 | No recording | No `MediaRecorder`, no storage APIs in app code | policy test |
| PRIV-010 | No tracking | No analytics, no external fonts/scripts; production CSP restricts connections to self + PeerJS Cloud | policy test, CSP in build |
| PRIV-011 | Connection authorization | Media only for the accepted participant; schema validation, 2 KB size limit, rate limit (20 msgs / 5 s), max 3 pending requests, max 5 unidentified handshakes (1 per peer), handshake timeout | unit |
| PRIV-012 | Honest claims | This document; README limitations | review |

## Group-specific guarantees (PA-006)

- **Nobody hears you without knowing and approving:** a newcomer gets your audio only after you yourself approved it, it is
  committed and visible in your participant list, and your mic is on at that moment. Mic-off members stay off.
- **No approval on someone else's behalf:** votes count only from the voter's own authorized link; each member additionally
  refuses the newcomer's mesh link and media offer unless it approved that admission itself (defense against a malicious coordinator).
- **Minimal pre-approval disclosure:** before all approvals the candidate learns nothing about the other members (no UIDs, no names,
  no IPs of members other than the coordinator). Members see only the candidate's UID and display name.
- **One capture for all peers;** mic off detaches every sender and stops the capture at once (verified up to 10 peers in unit tests,
  3 peers with getStats in Chromium).
- **No history to newcomers;** chat sender identity comes from the link, never from the payload; duplicates are dropped.
- **Early messages are inert:** anything a candidate sends before our own commit is held (max 16) and never shown or acted on;
  it is discarded if the admission is rolled back (D-023).
- **Vanished members stop receiving audio:** a member whose transport dies is removed after at most 30 s of ICE `disconnected`
  (its sender is detached, its playback stopped) instead of staying a "ghost" member (D-024).
- **Residual:** D-011 still applies to the coordinator; membership is not atomic (D-017): if the coordinator dies while its commit
  reached only some peers, the peers that did not commit roll back and close their links to the newcomer, while others keep it;
  each peer only sends audio to peers it has committed itself, so no one receives audio without their own approval, but lists
  can differ until someone leaves. Convergence is PA-011.

## Security concepts (do not conflate)

| Concept | Status in PsstAmigo |
|---|---|
| **Transport encryption** | Yes. WebRTC always encrypts media (DTLS-SRTP) and data channels (DTLS). Network observers cannot read audio or chat. |
| **Trusted signaling** | Assumed, not verified. DTLS certificate fingerprints are exchanged through PeerJS Cloud. Under normal operation PeerJS Cloud does not carry audio or messages, but a malicious or compromised signaling server could substitute fingerprints and sit in the middle. |
| **Authenticated end-to-end identity** | **No.** There is no out-of-band fingerprint/safety-number check and no account system. A UID only addresses a browser tab; it does not prove who is behind it. |

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
| Forged approval / introduction by a member or candidate | Votes bound to link identity; each member enforces its own approval for mesh-hello and media | — |
| Stale or replayed admission messages | 128-bit admission ids, finished-id memory (32), session id and member-set checks | — |
| Invite link leaks | Fragment-only (never sent to server), explicit confirmation, normal approval still required, fragment removed from the address bar after reading | Link = UID: D-011 applies; valid while the inviter's tab is open. The full link can remain in browser history (visited URL), in the clipboard and wherever it was shared. **An invite link is not a secret or an authentication token.** |
| Stranger guesses / learns a UID and calls | UID ≈ 59 bits random; every request needs explicit acceptance; no global directory | A known UID can still send request spam ⇒ rate/pending/handshake limits |
| **Requester learns your IP before you accept** | None possible with the current design: PeerJS answers every incoming *data* connection automatically, so ICE candidates (incl. your public IP via STUN) are exchanged when the request arrives, before you click Accept. No media or chat is exchanged before acceptance. | **Accepted, documented (D-011).** Share your UID only with people you would share your IP with. |
| Clickjacking: a malicious page embeds PsstAmigo with `allow="microphone"` | App refuses to start when framed (`main.ts`) | Meta CSP cannot set `frame-ancestors`; GitHub Pages cannot send `X-Frame-Options` |
| Pre-acceptance resource abuse (many handshakes, large binary chunks via PeerJS binary serializer) | Unidentified handshakes capped (5, one per peer) and time-limited; app messages size/rate-limited | PeerJS reassembles chunked binary data before our validation; a peer that knows your UID could waste memory/CPU until you reload |
| Unaccepted peer sends a media offer | Closed unanswered unless from the accepted participant | — |
| Offer cannot be inspected (PeerJS internal `options._payload` changes) | Fail-closed: verdict `unreadable` ⇒ closed unanswered; e2e tests would fail immediately | Calls stop working after such a PeerJS change until fixed (safe failure) |
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
  configuration, which replaces it for every call/data connection (D-003). Verified in e2e: every peer connection that starts ICE
  has only `stun:` servers.
- PeerJS's load-time feature detection (`util.supports`) creates one temporary `RTCPeerConnection` with its default (TURN) config
  and closes it immediately without `setLocalDescription`, so ICE gathering never starts and no TURN server is contacted.
  The e2e probe asserts that this connection never negotiates.
- PeerJS media connections include one internal data channel (used by PeerJS to signal close). It is allowed by the offer audit
  and carries no application data.

## Expected network connections (production)

| Destination | Protocol | Purpose |
|---|---|---|
| `bisbiliroglu.github.io` (GitHub Pages) | HTTPS | static files (HTML, JS, CSS) |
| `0.peerjs.com` | WSS (443) | signaling (allowed by CSP `connect-src`) |
| `stun.l.google.com:19302` | UDP (STUN) | public address discovery (WebRTC, not governed by CSP) |
| the other participant | UDP/TCP (WebRTC) | encrypted audio and data, peer-to-peer |

Nothing else: no fonts, CDNs, analytics or telemetry. Production bundle contains no other URLs.

## Content-Security-Policy (production, meta tag)

`default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self' https://0.peerjs.com wss://0.peerjs.com; media-src 'self' blob: mediastream:; object-src 'none'; base-uri 'none'; form-action 'none'`

- Verified on the production build: inline scripts and connections to other origins are blocked; no violations during a full call.
- No `unsafe-inline`, no `unsafe-eval`, no wildcards.
- **Not enforceable via meta CSP:** `frame-ancestors`, `report-uri`/`report-to`, `sandbox`. GitHub Pages cannot add headers, so
  framing is handled by the app refusing to run when framed. WebRTC (STUN/peer traffic) is not restricted by CSP.

## Privacy acceptance criteria (every release)

- [ ] First load: no permission prompt; `getUserMedia` not called.
- [ ] Joining/accepting: mic and speaker remain off.
- [ ] Mic off: browser recording indicator disappears; no outbound audio RTP.
- [ ] Speaker off: no playback; indicator 0.
- [ ] Leave / reload / close: no capture, no playback, no peer connections remain.
- [ ] No camera / screen permission is ever requested.
- [ ] `npm test` policy checks pass.
