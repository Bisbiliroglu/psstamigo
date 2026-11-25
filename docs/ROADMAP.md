# Roadmap

Status values: TODO · IN_PROGRESS · BLOCKED · REVIEW · DONE · DEFERRED · CANCELLED

| ID | Description | Depends on | Status | Notes |
|---|---|---|---|---|
| PA-001 | Project initialization and technical feasibility spike | — | REVIEW | Reviewed in PA-015 review (fixes in 0.0.2); manual real-network tests pending |
| PA-002 | Temporary identity and signaling lifecycle | PA-001 | REVIEW* | Core implemented in spike; remaining: signaling-loss UX, UID linger handling |
| PA-003 | Connection authorization and session state machine | PA-001 | REVIEW* | 1:1 implemented in spike; group transitions move to PA-006 |
| PA-004 | Direct peer-to-peer voice communication | PA-003 | REVIEW* | Works on one machine; needs real-network verification |
| PA-005 | Privacy-safe microphone and speaker lifecycle | PA-004 | REVIEW* | Implemented + automated checks; needs manual check of browser mic indicator |
| PA-006 | P2P mesh group session management (max 10, D-019) + invite links, low-bandwidth mode, compact layout (user requests) | PA-003, PA-005 | REVIEW | 0.1.0 deployed 2026-11-25 and verified live (CI 12/12 e2e, live 3-person smoke); manual tests pending |
| PA-007 | Ephemeral text messaging | PA-003 | REVIEW* | 1:1 done; group fan-out with PA-006 |
| PA-008 | Audio activity indicators | PA-005 | REVIEW* | Real-signal meters done; threshold tuning with real voices |
| PA-009 | Audio settings and individual volume controls | PA-005 | TODO | Device selection (`setSinkId`), per-participant volume |
| PA-010 | Main UI implementation and usability | PA-006 | TODO | Compact layout done early on user request (D-022); remaining: usability review |
| PA-011 | Reconnection and error recovery | PA-006 | TODO | ICE restart limits, signaling loss, safe defaults |
| PA-012 | Security hardening and protocol validation | PA-006 | TODO | Group protocol validation, fuzzing |
| PA-013 | Browser lifecycle and privacy verification | PA-011 | TODO | Edge/Chrome on Windows, BFCache, kill scenarios |
| PA-014 | Performance and real-world network testing | PA-006 | TODO | CPU/RAM in game, 10-person mesh (D-019), low-bandwidth quality (D-020), CGNAT matrix |
| PA-015 | GitHub Pages **test** deployment (brought forward, D-015) | PA-001 | REVIEW | 0.1.0 live and verified 2026-11-25; awaiting manual test results |
| PA-016 | Release candidate verification | all | TODO | |

\* The spike implemented the core of these tasks for 1:1 calls. The reordering (PA-015 before PA-006) was approved (D-015).
These tasks are **not** DONE: each stays in REVIEW until its remaining acceptance criteria are met.

## Remaining acceptance criteria per task

| Task | Remaining |
|---|---|
| PA-002 | Signaling-loss UX beyond one reconnect; behavior when PeerJS Cloud is down; UID linger after crash (documented only). User: UID/request flow works (B-03) |
| PA-003 | Manual verification of request/accept/reject across real networks; group transitions (PA-006) |
| PA-004 | One-way voice confirmed by user (B-08); explicit two-way (B-09), different ISPs (N-03), hotspot (N-04/05), latency/quality still open |
| PA-005 | User confirmed browser mic indicator disappears on mute (P-03 partial) and no audio with speaker off (P-05 partial); browser/OS not reported; Windows Chrome & Edge confirmation open |
| PA-007 | User confirmed chat with mic/speaker off (B-06); group fan-out implemented in PA-006 (automated); cross-network and group manual checks open |
| PA-008 | User confirmed indicators follow real audio (B-07/B-08); threshold tuning for speaking state open |
