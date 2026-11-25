# Roadmap

Status values: TODO · IN_PROGRESS · BLOCKED · REVIEW · DONE · DEFERRED · CANCELLED

| ID | Description | Depends on | Status | Notes |
|---|---|---|---|---|
| PA-001 | Project initialization and technical feasibility spike | — | REVIEW | Reviewed in PA-015 review (fixes in 0.0.2); manual real-network tests pending |
| PA-002 | Temporary identity and signaling lifecycle | PA-001 | REVIEW* | Core implemented in spike; remaining: signaling-loss UX, UID linger handling |
| PA-003 | Connection authorization and session state machine | PA-001 | REVIEW* | 1:1 implemented in spike; group transitions move to PA-006 |
| PA-004 | Direct peer-to-peer voice communication | PA-003 | REVIEW* | Works on one machine; needs real-network verification |
| PA-005 | Privacy-safe microphone and speaker lifecycle | PA-004 | REVIEW* | Implemented + automated checks; needs manual check of browser mic indicator |
| PA-006 | P2P mesh group session management (max 6) | PA-003, PA-005 | TODO | Introduction protocol, consistent participant list, join/leave announcements |
| PA-007 | Ephemeral text messaging | PA-003 | REVIEW* | 1:1 done; group fan-out with PA-006 |
| PA-008 | Audio activity indicators | PA-005 | REVIEW* | Real-signal meters done; threshold tuning with real voices |
| PA-009 | Audio settings and individual volume controls | PA-005 | TODO | Device selection (`setSinkId`), per-participant volume |
| PA-010 | Main UI implementation and usability | PA-006 | TODO | |
| PA-011 | Reconnection and error recovery | PA-006 | TODO | ICE restart limits, signaling loss, safe defaults |
| PA-012 | Security hardening and protocol validation | PA-006 | TODO | Group protocol validation, fuzzing |
| PA-013 | Browser lifecycle and privacy verification | PA-011 | TODO | Edge/Chrome on Windows, BFCache, kill scenarios |
| PA-014 | Performance and real-world network testing | PA-006 | TODO | CPU/RAM in game, 6-person mesh, CGNAT matrix |
| PA-015 | GitHub Pages **test** deployment (brought forward, D-015) | PA-001 | IN_PROGRESS | 0.0.1 live since 2026-11-25; 0.0.2 review fixes awaiting commit/push approval |
| PA-016 | Release candidate verification | all | TODO | |

\* The spike implemented the core of these tasks for 1:1 calls. The reordering (PA-015 before PA-006) was approved (D-015).
These tasks are **not** DONE: each stays in REVIEW until its remaining acceptance criteria are met.

## Remaining acceptance criteria per task

| Task | Remaining |
|---|---|
| PA-002 | Signaling-loss UX beyond one reconnect; behavior when PeerJS Cloud is down; UID linger after crash (documented only) |
| PA-003 | Manual verification of request/accept/reject across real networks; group transitions (PA-006) |
| PA-004 | Manual: two-way voice on LAN, different ISPs, hotspot; latency/quality notes |
| PA-005 | Manual: browser recording indicator disappears on mute (Chrome & Edge, Windows); no audio while speaker off on real hardware |
| PA-007 | Group fan-out (PA-006); manual chat check across networks |
| PA-008 | Threshold tuning with real voices; manual check that indicators match real speech |
