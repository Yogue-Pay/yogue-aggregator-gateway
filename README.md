# Yogue Aggregator Gateway

A separate, standalone service. Its own repo, own `package.json`, own
MongoDB, own deploy target — not part of `yogue-pay-backend-nodejs`.

## What it does

Sits in front of Yogue Pay's `/api/aggregator/v1/*` API (already built
inside `yogue-pay-backend-nodejs`) and re-exposes it under a stable,
client-facing path (`/v1/*`). Right now every request it receives gets
forwarded to Yogue Pay. The point of having this layer at all: when a
second provider gets added later (Stripe, another mobile money
aggregator, whatever a future business partner needs that Yogue Pay
alone doesn't cover), it slots in as a new adapter file — partners
integrating against this gateway never have to change their code, only
what happens behind this URL changes.

It also keeps its own record of everything that passes through it —
independent of whatever Yogue Pay (or any future provider) recorded on
its own side. That's what the gateway's MongoDB is for: one place with
the full picture across every provider it ever routes to, not just
whichever provider happened to handle a given request.

## What it does NOT do (yet)

- No credential issuance. A business still generates its API key/secret
  from their Yogue Pay dashboard login, same flow as before. This
  gateway never sees or stores that secret — it only forwards whatever
  `Authorization: Bearer ...` header the partner sends, and logs the
  public clientId portion of it (not the secret) for traceability.
- No token verification. Yogue Pay is the sole authority on whether a
  token is valid, active, or scoped correctly. This gateway only checks
  that the header is *shaped* like a bearer token before spending a
  network call forwarding it upstream.
- No dynamic provider selection logic yet. Every request goes to Yogue
  Pay by default; `?provider=` exists as a hook for later but nothing
  currently varies routing by client, currency, or country.

## Structure

```
server.js                              — entry point, DB connection, mounts routes
config/db.js                           — this gateway's own Mongo connection
config/providers.js                    — where provider base URLs/prefixes are registered
models/GatewayTransaction.js           — log of every request this gateway forwarded
services/gatewayLogService.js          — writes to GatewayTransaction, non-blocking
services/yoguePayAdapter.js            — the only file that knows Yogue Pay's specific API shape
services/providerRouter.js             — picks which adapter handles a given request
middleware/requireBearerToken.js       — rejects malformed auth headers before forwarding
middleware/requireGatewayAdminKey.js   — protects this gateway's own /admin/logs endpoints
routes/aggregatorGatewayRoutes.js      — the stable, partner-facing API surface (/v1/*)
routes/gatewayAdminRoutes.js           — view/summarize this gateway's own logs (/admin/*)
```

## Adding a second provider later

1. Add its base URL to `.env` and `config/providers.js`.
2. Create `services/<name>Adapter.js` with the same four exported
   functions as `yoguePayAdapter.js` (`getWallet`, `createDeposit`,
   `createWithdrawal`, `listTransactions`).
3. Register it in `services/providerRouter.js`'s `ADAPTERS` map.
4. Decide how routing picks a provider per request — today it's
   `?provider=name` in the query string defaulting to `yoguepay`; you
   may eventually want this to come from a client record instead, which
   would mean adding a `GatewayClient` model alongside
   `GatewayTransaction`.

## Environment variables

See `.env.example`.

- `YOGUE_PAY_BASE_URL` — required. Wherever `yogue-pay-backend-nodejs`
  is actually deployed.
- `MONGODB_URI` — required. This gateway's OWN database — do not point
  it at Yogue Pay's Mongo instance; keep them separate.
- `GATEWAY_ADMIN_KEY` — required to use the `/admin/logs` endpoints.
  Pick a long random string, share only with whoever needs log access.

## Running locally

```bash
npm install
cp .env.example .env
# edit .env — set YOGUE_PAY_BASE_URL, MONGODB_URI, GATEWAY_ADMIN_KEY
npm run dev
```

## Client-facing API

Same request/response shapes as Yogue Pay's `/api/aggregator/v1/*`,
just under `/v1/*` on this service's own domain/port instead:

- `GET /v1/wallet`
- `POST /v1/deposits`
- `POST /v1/withdrawals`
- `GET /v1/transactions`

All four require `Authorization: Bearer <clientId>.<apiKey>.<apiSecret>`
— the same credential a business generates from their Yogue Pay
dashboard.

## Gateway's own admin/observability API

Requires header `x-gateway-admin-key: <GATEWAY_ADMIN_KEY>`:

- `GET /admin/logs?clientId=&provider=&status=&action=&page=&limit=`
- `GET /admin/logs/summary` — counts grouped by provider/action/status
# yogue-aggregator-gateway
