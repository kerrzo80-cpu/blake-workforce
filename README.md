# Blake Workforce API

This is a standalone Workforce service. It owns mobile authentication and API permissions; the mobile app never connects directly to Blake.

## Current endpoints

- `GET /health`
- `POST /v1/auth/sign-in`
- `GET /v1/me`
- `GET /v1/jobs?date=YYYY-MM-DD`

Demo mode is for development only. Maintained deployments use server-to-server Blake storage with current company, account and employee checks, and managed signing/integration credentials. The client is configured only with this gateway URL. Never enable demo mode as a fallback for an unavailable business store.

## Business rule

The current company/employee purchasing permission determines whether a worker creates a PO or requests Office approval. Protected API requests recheck current access and use the company from the signed session, rather than accepting a company chosen in the request body.

## Optional Workforce web release

The gateway can serve a pinned public release of the maintained
`kerrzo80-cpu/blake-workforce-app` web client alongside its existing API. This
requires no additional service or dependency. It remains disabled by default.

Enable only on the intended service with these non-secret runtime settings:

- `WORKFORCE_WEB_ENABLED=true`
- `WORKFORCE_WEB_ENVIRONMENT=development` (or an explicitly reviewed production deployment)
- `WORKFORCE_WEB_OFFICE_ORIGIN=https://blake-ewg-development.onrender.com`

The browser API is always same-origin. No signing key, integration secret,
provider token or private backend response enters `config.js`. The existing
API still checks the current company, employee and permissions on each request.
The web flag does not enable demo mode or grant user access.

`/workforce-web-release.json` identifies the packaged client commit, asset hashes,
gateway commit, environment, Office origin and the already-public store host.
`/health` remains the API readiness endpoint. All web responses are `no-store`
and `nosniff`, with a same-origin Content Security Policy. Only the fixed public
asset list is served: there is no filesystem/SPA catch-all, remote proxy or
customer-data folder. Invalid settings or changed packaged assets prevent startup.

Update the packaged release from the maintained client's exact Git commit:

```
node scripts/package-workforce-web.mjs /path/to/blake-workforce-app <40-character-commit>
```

The script copies only tracked regular public web files, excluding its old
production config, tests, environment files, credentials and business data.
`web-release/` is a generated release artifact; do not edit it as a customer fork.
Run the maintained client's web tests, gateway tests and type check, then verify
an exact-commit deployment and its environment/health identity before connecting
Office's `VITE_WORKFORCE_APP_URL` to that web address. A loaded sign-in page does
not establish successful saved-record, physical-device or main-app acceptance.
