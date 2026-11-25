# Changelog

All notable user-facing changes. Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### 0.1.0 — PA-006 group sessions (test build, not deployed yet)

- Group voice and text chat for up to **10** people (full peer-to-peer mesh). Join through any member's UID.
- Every current member must approve a newcomer; until then the newcomer gets no audio, no member list and no chat history.
- The person who started the call can leave without ending it for the others.
- Join/leave notices in the chat; participant count "x/10"; per-participant voice indicator.
- **Low-bandwidth mode** above 5 people (16 kbps per voice stream).
- **Invite links:** "Davet linkini kopyala" → the friend opens the link and confirms before a request is sent.
- Compact layout (sidebar + single session panel), clearer "Teknik bağlantı bilgisi", voice-wave level meters.
- Protocol v2: clients older than 0.1.0 cannot join (explicit message, refresh needed).

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
