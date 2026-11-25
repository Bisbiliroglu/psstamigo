# Requirements

Status legend: ✅ implemented in spike · 🟡 partial · ⬜ not started

## Functional requirements

| ID | Requirement | Status (0.0.2) |
|---|---|---|
| FR-001 | Temporary UID: generate (CSPRNG), display, copy; regenerate on collision; new on reload | ✅ |
| FR-002 | Optional display name (sanitized, ≤ 32 chars, not persisted) | ✅ |
| FR-003 | Connection request by UID: send, accept, reject, cancel, timeout | ✅ |
| FR-004 | Direct 1:1 real-time voice | 🟡 automated on one machine and on the live site; real networks pending |
| FR-005 | Group voice via P2P mesh (max 6) | ⬜ PA-006 |
| FR-006 | Leave session and release all session resources | ✅ |
| FR-007 | Real microphone on/off | ✅ |
| FR-008 | Speaker (remote playback) on/off, independent of mic | ✅ |
| FR-009 | Local microphone activity indicator from the real signal | ✅ |
| FR-010 | Remote playback activity indicator from the played signal | ✅ |
| FR-011 | Per-participant speaking indicator | 🟡 level + hysteresis; tuning in PA-008 |
| FR-012 | Individual volume control | ⬜ PA-009 |
| FR-013 | Input/output device selection | ⬜ PA-009 |
| FR-014 | Echo cancellation, noise suppression, AGC (browser support) | 🟡 requested via constraints; no UI |
| FR-015 | Ephemeral text chat over DataChannel | ✅ |
| FR-016 | Connection recovery | 🟡 one bounded signaling reconnect; full engine PA-011 |
| FR-017 | Connection diagnostics (state, RTT, jitter, loss, ICE, path type) | 🟡 basic panel; media status shows interruptions |

## Session rules

| ID | Rule |
|---|---|
| SR-001 | No rooms/channels to manage; sessions form by UID requests. |
| SR-002 | The target must explicitly accept before any media flows. |
| SR-003 | Self-connection and duplicate requests are prevented. |
| SR-004 | Invalid UIDs are rejected locally with a clear message. |
| SR-005 | Request, handshake and media setup have timeouts; no infinite retries. |
| SR-006 | Unexpected media / data connections are closed. |
| SR-007 | A user is in at most one session at a time; sessions are never merged automatically. |
| SR-008 | The initiator leaving does not end the session for others (mesh, PA-006). |
| SR-009 | All participants are visible; joins and leaves are announced. |
| SR-010 | Only verifiably audio-only media offers are answered (fail-closed, D-010). |
| SR-011 | The app does not run inside frames (D-012). |

## Privacy requirements

PRIV-001 … PRIV-012 are defined in [PRIVACY_SECURITY.md](PRIVACY_SECURITY.md) and summarized in `CLAUDE.md`.
They apply from the first line of code.

## Non-functional requirements (targets, not measurements)

| ID | Requirement | Target | Measured |
|---|---|---|---|
| NFR-001 | Hosting cost | 0 | GitHub Pages + PeerJS Cloud (free) |
| NFR-002 | Extra platform accounts | 0 | 0 (GitHub only) |
| NFR-003 | Group size | 6 | 1:1 only so far |
| NFR-004 | Bundle size | < 1 MB compressed | 0.0.2: ≈ 38.9 KB gzip (JS 35.17 + CSS 1.58 + HTML 2.11) |
| NFR-005 | Codec | Opus | browser default for WebRTC audio (not forced) |
| NFR-006 | Latency | as low as reasonably achievable | not measured |
| NFR-007 | Background operation | supported | not killed by blur/visibility; real game test pending |
| NFR-008 | CPU / memory | minimal | not measured |
| NFR-009 | Recordings / message persistence | none | none |
| NFR-010 | Primary platform | Chrome & Edge, Windows | automated: Chromium on macOS |
