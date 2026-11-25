# Requirements

Status legend: ✅ implemented in spike · 🟡 partial · ⬜ not started

## Functional requirements

| ID | Requirement | Status (0.1.0) |
|---|---|---|
| FR-001 | Temporary UID: generate (CSPRNG), display, copy; regenerate on collision; new on reload | ✅ |
| FR-002 | Optional display name (sanitized, ≤ 32 chars, not persisted) | ✅ |
| FR-003 | Connection request by UID: send, accept, reject, cancel, timeout | ✅ |
| FR-004 | Direct 1:1 real-time voice | 🟡 automated on one machine and on the live site; real networks pending |
| FR-005 | Group voice via P2P mesh (max 10, D-019) | 🟡 implemented; automated (unit + Chromium up to 10 contexts); real networks pending |
| FR-006 | Leave session and release all session resources | ✅ |
| FR-007 | Real microphone on/off | ✅ |
| FR-008 | Speaker (remote playback) on/off, independent of mic | ✅ |
| FR-009 | Local microphone activity indicator from the real signal | ✅ |
| FR-010 | Remote playback activity indicator from the played signal | ✅ |
| FR-011 | Per-participant speaking indicator | 🟡 per-participant level (one MeterLoop); threshold tuning in PA-008 |
| FR-012 | Individual volume control | ⬜ PA-009 |
| FR-013 | Input/output device selection | ⬜ PA-009 |
| FR-014 | Echo cancellation, noise suppression, AGC (browser support) | 🟡 requested via constraints; no UI |
| FR-015 | Ephemeral text chat over DataChannel (group fan-out, de-duplicated, sender = link identity) | ✅ automated |
| FR-016 | Connection recovery | 🟡 one bounded signaling reconnect; full engine PA-011 |
| FR-017 | Connection diagnostics (state, RTT, jitter, loss, ICE, path type) | 🟡 "Teknik bağlantı bilgisi" panel; media status shows interruptions |
| FR-018 | Invite link (`#join=<uid>`), explicit confirmation before sending a request (D-021) | ✅ automated |
| FR-019 | Low-bandwidth voice mode above 5 participants (D-020) | ✅ automated (parameters); audio quality not verified |

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
| SR-008 | The initiator leaving does not end the session for others (GR-008). |
| SR-009 | All participants are visible; joins and leaves are announced. |
| SR-010 | Only verifiably audio-only media offers are answered (fail-closed, D-010). |
| SR-011 | The app does not run inside frames (D-012). |

## Group requirements (PA-006)

| ID | Requirement | Status |
|---|---|---|
| GR-001 | Implicit session creation on first acceptance; session id is internal, not a credential | ✅ |
| GR-002 | Join through any member's UID | ✅ |
| GR-003 | Full mesh: one application DataConnection + one MediaConnection per pair, no duplicates | ✅ |
| GR-004 | Max `MAX_PARTICIPANTS` (10, D-019); concurrent admissions cannot exceed it | ✅ |
| GR-005 | Consent of every current member; commit separate from acceptance (D-016) | ✅ |
| GR-006 | Visible participant list keyed by UID (same display names stay distinct) | ✅ |
| GR-007 | Join/leave system messages (session memory only) | ✅ |
| GR-008 | Initiator-independent session; temporary coordinator only (D-017) | ✅ |
| GR-009 | Leaving cleans only own links; last member returns to safe idle | ✅ |
| GR-010 | One session at a time; no automatic merging | ✅ |

All GR items: automated only; real-network verification pending (release gate).

## Privacy requirements

PRIV-001 … PRIV-012 are defined in [PRIVACY_SECURITY.md](PRIVACY_SECURITY.md) and summarized in `CLAUDE.md`.
They apply from the first line of code.

## Non-functional requirements (targets, not measurements)

| ID | Requirement | Target | Measured |
|---|---|---|---|
| NFR-001 | Hosting cost | 0 | GitHub Pages + PeerJS Cloud (free) |
| NFR-002 | Extra platform accounts | 0 | 0 (GitHub only) |
| NFR-003 | Group size | 10 (D-019) | automated up to 10 Chromium contexts on one machine |
| NFR-004 | Bundle size | < 1 MB compressed | 0.1.0: ≈ 44 KB gzip (see PROJECT_STATUS) |
| NFR-005 | Codec | Opus | browser default for WebRTC audio (not forced) |
| NFR-006 | Latency | as low as reasonably achievable | not measured |
| NFR-007 | Background operation | supported | not killed by blur/visibility; real game test pending |
| NFR-008 | CPU / memory | minimal | not measured |
| NFR-009 | Recordings / message persistence | none | none |
| NFR-010 | Primary platform | Chrome & Edge, Windows | automated: Chromium on macOS |
