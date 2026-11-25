# PsstAmigo

**Connect. Talk. Play.**

A lightweight, privacy-focused, peer-to-peer voice and text communication application.
No accounts, no cameras, no screen sharing, no recordings.

PsstAmigo is a hobby project for talking with friends while gaming. Open the page, share your temporary UID,
your friend enters it, you accept — and you can talk and chat. It is not a Discord replacement and does not try to be.

> **Status:** `0.0.1` — technical spike (PA-001). 1:1 calls only; group calls (up to 6) are planned. See [docs/ROADMAP.md](docs/ROADMAP.md).

## How it works

- Each page load gets a random temporary UID (e.g. `psst-7k3m-q9xd-2fha`). Reloading gives a new one.
- Enter a friend's UID → they see a request → they accept or reject.
- Microphone and speaker are **off** by default. Nothing is captured or played until you click.
- Voice and text go directly between browsers (WebRTC). The website itself (GitHub Pages) only serves static files.
- Text messages live only in memory and disappear when the call ends or the page closes.

## Technology

TypeScript (strict) · Vanilla DOM · Vite · WebRTC · PeerJS (signaling via the free PeerJS Cloud server) · public STUN ·
Vitest · Playwright · GitHub Pages · MIT license. The only runtime dependency is `peerjs`.

## Development

Requires Node.js 20.19+ (developed with Node 26).

```bash
npm ci
npm run dev          # http://localhost:5173/psstamigo/
npm run typecheck
npm test             # unit tests
npx playwright install chromium   # once
npm run test:e2e     # browser tests (needs internet for PeerJS Cloud)
npm run build        # production build in dist/
```

## Deployment

The app is a static build served from GitHub Pages under `/psstamigo/`
(`vite.config.ts` → `base`). The workflow in `.github/workflows/deploy.yml` builds, tests and deploys on pushes to `main`
once GitHub Pages is configured to use **GitHub Actions** as its source.

The page has `<meta name="robots" content="noindex, nofollow">` and a production Content-Security-Policy.
**`noindex` is not access control:** anyone with the URL can open the site, and the public repository itself is indexable.

## Known limitations (honest summary)

- **No TURN server.** Some network combinations (symmetric NAT, carrier-grade NAT, many mobile networks) cannot connect
  directly. The app shows an error instead of pretending to connect.
- **PeerJS Cloud** is a free third-party service without a documented SLA, limits or terms. It can see UIDs, IP addresses
  and who connects to whom (connection metadata), not your audio or messages.
- **Google public STUN** sees your public IP address.
- **Participants learn each other's public IP addresses** (peer-to-peer).
- Audio and data are encrypted in transit by WebRTC (DTLS-SRTP / DTLS), but there is **no authenticated end-to-end identity
  verification**. A UID is not proof of who someone is.
- The app cannot prevent other participants from recording on their own devices with external software.
- Chrome and Edge on Windows are the primary targets. Other browsers are untested.

Full details: [docs/PRIVACY_SECURITY.md](docs/PRIVACY_SECURITY.md).

## Documentation

[Requirements](docs/REQUIREMENTS.md) · [Architecture](docs/ARCHITECTURE.md) · [Privacy & Security](docs/PRIVACY_SECURITY.md) ·
[Roadmap](docs/ROADMAP.md) · [Status](docs/PROJECT_STATUS.md) · [Test plan](docs/TEST_PLAN.md) · [Decisions](docs/DECISIONS.md) ·
[Changelog](CHANGELOG.md)

## License

[MIT](LICENSE)
