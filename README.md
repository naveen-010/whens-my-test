# When's My Test

A section-aware, community-maintained test calendar for BITS Pilani students. Students follow courses, see announced tests at a glance, corroborate exact announcements, resolve corrections with an auditable history, discuss individual tests, and optionally sync them to a dedicated Google Calendar.

## Trust workflow

- A new test is visible immediately as a single-source report; its creator is the first attestation.
- A second independent attestation marks the current test version as corroborated.
- Date, time, and section edits create a new claim version instead of keeping stale corroborations.
- Structured correction proposals show their reason publicly. Two matching student reports can apply ordinary corrections; official, conflicting, spam, and duplicate cases require a reporter or moderator decision.
- Creators can edit, cancel, reinstate, or retract mistaken reports. Shared activity history is retained.
- Each test has a focused discussion thread. Discussion comments never silently alter calendar facts.
- Google Calendar can keep cancellations as visible `[CANCELLED]` events or remove them immediately.

## Architecture

- React + Vite frontend on Vercel
- Fastify API and background calendar worker on the Oracle server
- PostgreSQL in a private Docker network
- Google OAuth restricted to verified `@pilani.bits-pilani.ac.in` accounts
- Google Calendar access requested separately and stored encrypted at rest

The public frontend uses the same-origin `/api` path. Vercel securely rewrites that path to the TLS-protected API at `mondstadt.duckdns.org/whens-my-test-api/`.

## Run the frontend locally

```bash
npm install
npm run dev
```

Vite proxies `/api` to the deployed backend by default. To use a local API instead:

```bash
VITE_API_PROXY=http://127.0.0.1:8080 npm run dev
```

## Deploy the backend

Create `/home/ubuntu/whens-my-test/.env` from `.env.production.example`, then run:

```bash
docker compose up -d --build
```

Google Cloud needs a Web application OAuth client with the Google Calendar API enabled and these exact authorized redirect URIs:

```text
https://whens-my-test.vercel.app/api/auth/google/callback
https://whens-my-test.vercel.app/api/calendar/callback
```

Put the client ID and secret in `.env`, then recreate the API and worker:

```bash
docker compose up -d --force-recreate api worker
```

## Operations

- Health: `https://mondstadt.duckdns.org/whens-my-test-api/health`
- Backups: daily systemd timer using `ops/backup.sh`, retained for 14 days
- Restore procedure: `ops/restore.md`
- PostgreSQL and application containers are not exposed publicly; only Nginx can reach the API on `127.0.0.1:8094`

## Checks

```bash
npm run lint
npm run build
npm --prefix server run check
npm --prefix server run build
npm audit --omit=dev
npm --prefix server audit --omit=dev
```
