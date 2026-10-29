# Blake Workforce API

This gateway verifies existing Blake staff credentials and issues mobile sessions scoped to the intended account and company. The mobile app accesses Blake through the gateway's authenticated routes.

## Current endpoints

- `GET /health`
- `POST /v1/auth/sign-in`
- `GET /v1/me`
- `GET /v1/jobs?date=YYYY-MM-DD`

The included demo mode is for development only. Configure the gateway's managed signing/sync secrets and intended Blake authentication/store upstreams separately for each environment. The maintained integration uses the existing Blake backend; a separate PostgreSQL service is not a prerequisite. The Workforce app is configured with this gateway's URL.

## Business rule

The backend supplies each account's current purchasing permission. Preserve the company policy and individual account setting; a client cannot choose its own purchasing grant.

## Verification and release order

Use Node.js 22, then run `npm ci --no-audit --no-fund`, `npm run typecheck` and `npm test`. The integration tests start loopback gateway/backend fixtures with generated credentials and explicit isolated upstream URLs. They do not require deployment secrets or access a real company, email service or payment provider.

Pull requests run the same commands through the verification workflow, without deployment or signing credentials. Passing these checks verifies the gateway software, not a released native binary or provider delivery.

Coordinate the reviewed Blake backend, gateway and native versions. The updated client requires the corresponding break-recording and protected-file routes. Align the authorised backend/gateway release before distributing the client. A draft PR or successful verification job does not authorise a Production deployment.
