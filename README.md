# PsstAmigo

**Connect. Talk. Play.**

A lightweight, privacy-focused, peer-to-peer voice and text communication application.
No accounts, no cameras, no screen sharing, no recordings.

PsstAmigo is a hobby project for talking with friends while gaming. Open the page, share your temporary UID,
your friend enters it, you accept — and you can talk and chat. It is not a Discord replacement and does not try to be.

> **Status:** `0.1.0` — group calls up to 10 people (test build; live site may still run 0.0.2 until deployed). Not a stable release. See [docs/ROADMAP.md](docs/ROADMAP.md).

## How it works

- Each page load gets a random temporary UID (e.g. `psst-7k3m-q9xd-2fha`). Reloading gives a new one.
- Enter a friend's UID (or send them your **invite link**) → they see a request → they accept or reject.
- Group calls up to 10 people: a newcomer can ask any member; **every** member must approve. Above 5 people a low-bandwidth
  voice mode is used. The person who started the call can leave without ending it.
- Microphone and speaker are **off** by default. Nothing is captured or played until you click.
- Voice and text go directly between browsers (WebRTC). The website itself (GitHub Pages) only serves static files.
- Text messages live only in memory and disappear when the call ends or the page closes.
- "Ses ayarları": pick microphone and headset, test them locally, adjust volumes per person. Optional "remember my devices"
  stores only device ids, volume and processing toggles in this browser. Only one PsstAmigo tab per browser is active.

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
npm run test:e2e:preview   # same tests against the production build (with CSP)
npm run build        # production build in dist/
```

## Deployment

Test deployment: https://bisbiliroglu.github.io/psstamigo/ (static build under `/psstamigo/`, see `vite.config.ts` → `base`).
`.github/workflows/deploy.yml` type-checks, runs unit tests, builds, checks the production privacy settings and deploys on pushes
to `main` (GitHub Pages source: **GitHub Actions**). Browser tests run separately in `.github/workflows/browser-tests.yml`.
The app refuses to run inside frames.

The page has `<meta name="robots" content="noindex, nofollow">` and a production Content-Security-Policy.
**`noindex` is not access control:** anyone with the URL can open the site, and the public repository itself is indexable.

## Known limitations (honest summary)

- **No TURN server.** Some network combinations (symmetric NAT, carrier-grade NAT, many mobile networks) cannot connect
  directly. The app shows an error instead of pretending to connect.
- **PeerJS Cloud** is a free third-party service without a documented SLA, limits or terms. It can see UIDs, IP addresses
  and who connects to whom (connection metadata), not your audio or messages.
- **Google public STUN** sees your public IP address.
- **Participants learn each other's public IP addresses** (peer-to-peer). Because PeerJS negotiates the connection as soon as a
  request arrives, **anyone who knows your UID can learn your public IP even before you accept** (no audio or chat is shared before
  acceptance). Share your UID only with people you trust.
- Audio and data are encrypted in transit by WebRTC (DTLS-SRTP / DTLS), but there is **no authenticated end-to-end identity
  verification**. A UID is not proof of who someone is.
- **Signaling is trusted, not verified:** PeerJS Cloud does not carry audio or chat in normal operation, but it relays the
  encryption fingerprints, so a malicious or compromised signaling server could sit in the middle of a call. This is not mitigated.
- The app cannot prevent other participants from recording on their own devices with external software.
- Full mesh: every participant connects to every other one. Without TURN, a single pair that cannot connect prevents a newcomer
  from joining. With many people CPU/upload use grows (10 people = 9 outgoing voice streams); not yet measured.
- Group membership is not atomic: after a crash mid-join, participants may see different lists until someone leaves
  (each still sends audio only to people it approved itself).
- A participant whose browser crashes or loses the network is removed by the others after about 30–40 seconds and must send a
  new join request (everyone approves again). Short interruptions recover by themselves; a broken voice path is rebuilt
  automatically; signaling outages do not end calls. Recovery does **not** fix NAT/firewall problems (no TURN) and is not
  guaranteed under every network condition; background tabs may recover more slowly.
- An invite link is not a secret: it contains your temporary UID and can stay in browser history or wherever it was shared.
- If a selected headset or microphone disconnects, the app turns it off instead of switching devices, but the operating system
  may briefly reroute audio before the browser tells the app. "System default" follows the OS default device.
- Chrome and Edge on Windows are the primary targets. Other browsers are untested.

Full details: [docs/PRIVACY_SECURITY.md](docs/PRIVACY_SECURITY.md).

## Documentation

[Requirements](docs/REQUIREMENTS.md) · [Architecture](docs/ARCHITECTURE.md) · [Privacy & Security](docs/PRIVACY_SECURITY.md) ·
[Roadmap](docs/ROADMAP.md) · [Status](docs/PROJECT_STATUS.md) · [Test plan](docs/TEST_PLAN.md) · [Decisions](docs/DECISIONS.md) ·
[Changelog](CHANGELOG.md)

## License

[MIT](LICENSE)
