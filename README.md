# Blake Workforce API

This is a standalone Workforce service. It owns mobile authentication and API permissions; the mobile app never connects directly to Blake.

## Current endpoints

- `GET /health`
- `POST /v1/auth/sign-in`
- `GET /v1/me`
- `GET /v1/jobs?date=YYYY-MM-DD`

The included demo mode is for development only. Before production deployment it must use a dedicated PostgreSQL store, a managed secret, object storage for evidence, and a server-to-server Blake integration account. The Workforce app is then configured only with this service URL.

## Business rule

EWG users receive `purchasePermission: create`. New client organisations receive `request` by default, so their plumbers submit a request to office rather than create a PO.
