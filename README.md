# When's My Test

A section-aware, community-maintained test calendar for BITS Pilani students. Students follow their courses, see announced tests at a glance, confirm reports from classmates, and optionally sync tests to a dedicated Google Calendar.

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

The development origin is allowed by the API, so `http://localhost:5173` can use the deployed backend.

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
