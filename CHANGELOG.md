# Changelog

All notable user-facing changes. Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

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
