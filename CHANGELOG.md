# Changelog

All notable user-facing changes. Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### 0.0.2 — PA-015 review fixes (test deployment)

- Security: incoming media offers are audited fail-closed; unreadable or non-audio offers are rejected without answering.
- Security: the app refuses to run inside another page's frame (clickjacking protection).
- Security: limits for unidentified incoming handshakes (max 5, one per peer).
- Fix: participant voice status shows "ses kesintide…" during network interruptions instead of "ses bağlı".
- Fix: a late "UID unavailable" error for an earlier target no longer cancels a new request.
- CI: least-privilege deploy workflow with production privacy checks; separate browser-test workflow.
- Docs: documented that a requester can learn your public IP before you accept (PeerJS limitation).

### Added (0.0.1 — technical spike, PA-001)

- Temporary, cryptographically random UID per page load, with copy button.
- Optional display name.
- Connection requests by UID with explicit accept / reject, timeouts and duplicate/self protection.
- 1:1 voice call (WebRTC, audio only) and ephemeral text chat over a data channel.
- Microphone and speaker off by default; real microphone shutdown (capture stopped, sender detached).
- Live microphone and speaker level indicators driven by the real audio signal; per-participant level.
- Leave call; full cleanup on leave and on page close/reload.
- Basic connection diagnostics (connection/ICE state, RTT, jitter, packet loss, candidate types).
- `noindex` and production Content-Security-Policy.
