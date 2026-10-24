# Nino native commerce API

Cloudflare Worker + D1 backend for the storefront's native cart, Stripe-hosted payment, and Printful fulfillment. Etsy is not involved in checkout or order creation. Existing Printful sync products can be read from the selected store, including an existing linked store.

The dedicated `nino-printful-commerce` D1 database is deployed with the migration applied. The Worker is deployed at `https://nino-printful-commerce-api.ijpbattaglia.workers.dev`; `wrangler.jsonc` records its nonsecret binding and disabled activation settings. The owner selected calculated shipping worldwide wherever Printful offers delivery. Stripe account access has been confirmed; the live account’s Tax setup is active. Secure server credentials and tax verification for the server’s selected test/live environment remain pending; no live charge or print order has been submitted. Checkout and fulfillment remain disabled until activation is configured and verified.

## Files and validation

`src/worker.mjs` exposes the API and scheduled retry/sync handler. `migrations/0001_printful_commerce.sql` defines a separate Printful schema. `foundation-wrangler.original.jsonc` preserves the original Dropbox worker's deployment configuration without modifying it. Do not apply this migration as an upgrade to the old Gelato schema; use a separate D1 database.

```sh
npm ci --ignore-scripts
npm test
WRANGLER_SEND_METRICS=false WRANGLER_LOG_PATH=./build-check.log npm run check
```

Tests use SQLite through Node's `node:sqlite` and mocked provider transports. They include the actual Stripe SDK's local signature verification. No test calls a payment or fulfillment API. The Worker bundle was checked with Stripe 22.6.0 and Wrangler 4.151.1. Tests were run with Node 25.0.0.

## Configuration required before activation

Current owner requirement (October 17): the Nino website must operate independently of Etsy. The tracked configuration therefore selects `PRINTFUL_CATALOG_MODE=store`. Configure a dedicated Printful Manual order/API store and its real published products/variants, rather than relying on the previously inspected Etsy-linked store. Existing source-import images are local site assets. New public product images reject Etsy and its image CDN, using independent Printful images when available. A plain unpublished design template is not a purchasable product. The generic `sync` mode remains supported for other explicitly chosen integrations; it is not the selected Nino deployment mode.

Use the dedicated database binding in the deployment's tracked `wrangler.jsonc` and verify the supplied migration has been applied before opening checkout. `wrangler.example.jsonc` remains a disabled template for isolated local setups; it can be copied to an untracked `wrangler.local.jsonc` when needed. Do not point it at the old Gelato database.

Store the following as Worker secrets, outside source control:

| Secret | Required value |
| --- | --- |
| `STRIPE_SECRET_KEY` | A restricted server API key from the owner's selected Stripe account or separate Stripe sandbox. The client needs Checkout Sessions creation/retrieval and line-item retrieval, with access to the inline Products/Prices and expanded PaymentIntent/Charge data. Calculated shipping plus automatic tax also creates a Customer. Grant only the API operations used by `src/providers.mjs`. |
| `STRIPE_WEBHOOK_SECRET` | The signing secret for this API's Stripe event endpoint in the same test/live environment. |
| `PRINTFUL_ACCESS_TOKEN` | A private token for the intended Printful store, with `sync_products/read` and `orders` access. An account-level token must be scoped to the configured store through `X-PF-Store-Id`; the client always sends that header. |
| `ADMIN_API_TOKEN` | A high-entropy bearer token for the private catalog-sync, order-inspection and manual retry routes. Never expose it in frontend JavaScript. |

Set these nonsecret variables explicitly:

| Variable | Meaning |
| --- | --- |
| `STOREFRONT_ORIGIN` | Exact HTTPS storefront origin, without a trailing slash. Only this browser origin can create a checkout or shipping quote. |
| `PRINTFUL_STORE_ID` | Numeric ID of the existing store whose synced variants will be sold. |
| `PRINTFUL_CATALOG_MODE` | `sync` for an existing ecommerce-linked store; `store` for a Manual order/API store. Both use real configured sync variants, not product-template IDs. |
| `STRIPE_MODE` | `test` or `live`, matching the API key and webhook endpoint. Only `sk_test_`/`rk_test_` keys are accepted in test mode, and `sk_live_`/`rk_live_` keys in live mode. Missing/mismatched keys return 503 before SDK construction or provider requests. Mismatched events are rejected. |
| `SHIPPING_MODE` | The owner selected `calculated`. Other supported modes are `flat` and `free`; empty means checkout remains unavailable. |
| `SHIPPING_COUNTRIES` | `PRINTFUL` uses Printful’s current accepted country list for worldwide delivery. An explicit comma-separated list of ISO country codes is also supported. The accepted list is read from Printful’s `/countries` endpoint and cached for six hours in the existing D1 settings table. Missing credentials or unusable expired/malformed country data keep checkout closed. A valid current rate is still required for the actual cart and address; the country list alone never promises delivery. |
| `SHIPPING_RATE_CENTS` | Positive integer minor-unit amount approved by the owner when mode is `flat`. No guessed rate is supplied. Ignored for `free` or `calculated`. |
| `SHIPPING_RATE_NAME` | Customer-facing name for the configured flat/free rate. |
| `STRIPE_PRODUCT_TAX_CODE` | Optional store-specific Stripe product tax classification. The dedicated ordinary adult/unisex shirt catalog uses `txcd_30011000` (Clothing & Footwear), explicitly on Checkout line items. Unset preserves the generic behavior; no Stripe account default is changed. |
| `STRIPE_TAX_MODE` | The owner selected automatic tax. The deployment records `automatic`; empty means checkout remains unavailable. |
| `STRIPE_TAX_REGISTRATION_CONFIRMED` | Keep `false` until active Tax settings/registrations are verified in the same Stripe account and test/live environment as the installed server key. Live account Tax setup has been completed, but the server remains in test mode without its credentials. The code does not register a business or jurisdiction. |
| `CHECKOUT_SUCCESS_PATH`, `CHECKOUT_CANCEL_PATH` | Same-origin storefront return paths. The default success path includes Stripe's Checkout Session placeholder. Update these to the actual frontend routes. |
| `CHECKOUT_ENABLED` | Keep `false` until the account, catalog, shipping, tax choice and event endpoint are configured and reviewed. |
| `FULFILLMENT_ENABLED` | Keep `false` during sandbox payment testing. Live checkout also requires this to be `true`. Turning it off pauses new supplier submissions while retaining paid orders for recovery. |

The configured product tax code is scoped to this current shirt catalog. Future different product types need their correct Stripe tax classifications before being sold; do not assume this code is appropriate for every item. The classification is stored in each new order snapshot so a retry uses the same value. It does not enable automatic tax, confirm a registration, change account defaults, or open checkout.

Optional `CATALOG_MAX_AGE_SECONDS` defaults to 86400. Older catalogs cannot create checkouts and their variants become unavailable. Optional `PRINTFUL_MAX_ORDER_COST_CENTS` can impose a lower supplier-cost ceiling; otherwise the paid order total minus customer tax is the ceiling. Supplier costs beyond the ceiling are held for review, never silently confirmed.

Configure the Stripe event endpoint as `POST /api/webhooks/stripe` using API version `2026-08-26.dahlia`, subscribed to:

- `checkout.session.completed`
- `checkout.session.async_payment_succeeded`
- `checkout.session.async_payment_failed`

The server verifies the raw-body signature, retrieves the current Session and expanded payment/charge, and checks paid status, currency, totals, immutable cart metadata, exact line items and refund state. Return pages do not fulfill orders. This follows Stripe's [Checkout fulfillment guidance](https://docs.stripe.com/checkout/fulfillment.md?payment-ui=stripe-hosted) and [event verification guidance](https://docs.stripe.com/events/manage-webhook-endpoints).

Use a separate Stripe sandbox for testing. A successful **test-mode** payment is recorded as `test_paid` and never calls Printful to create or confirm an order, even if the fulfillment flag is accidentally enabled. Printful draft/confirmation recovery is tested with fixtures only; a real supplier proof remains a separately authorized production step.

## Frontend API contract

The public read-only `GET /api/products`, `GET /api/commerce-config` and `GET /api/health` endpoints send `Access-Control-Allow-Origin: *`, so private previews and localhost can read catalog/readiness without credentials. Checkout/quote POST requests still require the exact configured storefront origin. Admin and guest receipt routes retain their authorization and origin protections.

`GET /api/products` returns the authoritative gate and completed catalog:

```json
{
  "checkout_ready": false,
  "catalog_ready": false,
  "catalog_complete": false,
  "shipping_mode": "calculated",
  "shipping_countries": [],
  "products": []
}
```

When configured and synced, each product has `id`, `external_id`, `title`, `image`, and `variants`. Each variant has `id`, actual `name`/`size`/`color` labels, `image`, `price:{amount,currency}`, `available`, and `max_quantity:10`. **Amounts are integer cents.** Only USD variants with an explicit retail price, an active/synced mapping and ready print files enter this catalog; other currencies are rejected, never relabeled or converted. Public responses omit print files and provider credentials. Treat absent/false `checkout_ready` as closed. Public catalog/config reads retain HTTP 200 with `shipping_countries:[]` and closed readiness when the worldwide country source is unavailable; checkout and fulfillment still require a fresh accepted list.

`GET /api/commerce-config` exposes the same readiness and shipping settings plus cart limits. Maximums are 10 units per variant, 50 total units and 20 distinct variants.

`POST /api/checkout`, from the storefront origin:

```json
{
  "request_id": "a-client-generated-uuid-stable-for-this-unchanged-cart",
  "items": [{"product_id":"101","variant_id":"501","quantity":1}]
}
```

The example IDs above are fixtures, not real store IDs. Do not send prices, totals, artwork URLs or customer payment data. The server rechecks the current Printful mapping, availability and retail price. Response: `{checkout_url,order_id,receipt_token,request_id}`. Redirect only to the returned Stripe-hosted URL. Keep the request UUID across a failed/retried attempt; generate a new one when the cart changes. `Idempotency-Key` can supply the same value instead. Reusing one ID for different items returns 409. An expired checkout attempt requires a new ID. Stripe Session creation has its own stable idempotency key, and saved order snapshots cannot be updated.

Flat/free shipping collects the delivery address in hosted Checkout. Calculated shipping requires the additional address-review flow below; the frontend follows the server’s calculated-shipping policy chosen by the owner.

### Calculated shipping

1. `POST /api/shipping-quotes` with `{items,recipient:{name,address1,address2,city,state_code,country_code,zip}}`.
2. Display the exact ship-to address and returned rate choices. The response is `{quote_id,expires_at,rates:[{id,name,amount,currency}]}`.
3. After the customer reviews the address/rate, include `shipping_quote_id` and `shipping_rate_id` with the checkout body.

Quotes last 15 minutes and are bound to the normalized cart and server-stored recipient. The chosen address is attached to `payment_intent_data.shipping`; Stripe is not allowed to collect a second shipping address for that quote. When automatic tax is configured, a Customer is created with that same shipping address. Fulfillment uses the stored quoted recipient and checks the paid shipping destination. The provider's actual shipping-rate response determines the amount; browser amounts are never accepted. Printful documents this [shipping-rate API](https://developers.printful.com/docs/#tag/Shipping-Rate-API).

`GET /api/orders/{order_id}?token={receipt_token}` returns only payment/fulfillment status and paid amount; it does not expose an address or email. Keep guest receipt tokens private. `confirmed` means submitted to Printful, **not shipped or delivered**. Shipping/tracking callbacks and customer accounts are outside this implementation.

## Catalog sync and recovery

Admin routes require `Authorization: Bearer ADMIN_API_TOKEN`:

- `POST /api/admin/catalog/sync` starts or resumes a full store snapshot and processes at most 10 product details.
- `POST /api/admin/catalog/sync/{sync_id}` continues the next batch; repeat until `complete:true`.
- `GET /api/admin/catalog/sync/{sync_id}` reports progress.
- `GET /api/admin/orders` lists recent states, supplier IDs and error codes without address/email data.
- `POST /api/admin/orders/{order_id}/retry` retries an existing paid live order held in `retry`, `review` or `draft` after the owner resolves its cause. It never changes the original price/artwork snapshot or makes an unpaid order eligible.

The first catalog sync is staged under a generation ID and only replaces the public catalog once complete. After that, syncs update the live catalog in place and write only products whose data changed (D1 counts every written row, index entries included, against the daily free-tier quota of 100,000; re-copying the full catalog every six hours exceeded it). Each product is replaced atomically, and products removed from Printful are dropped only when a sync completes, so a partial sync cannot erase existing stock. The every-minute schedule resumes batches and retries up to three eligible paid orders. The daily schedule (`0 10 * * *`, 10:00 UTC) starts a new sync when none is running and deletes up to 5,000 rows of older catalog generations per day. `CATALOG_MAX_AGE_SECONDS` defaults to two days so one missed sync does not close checkout. The tracked deployment configuration enables the Worker schedules; without provider credentials they perform no supplier work. Verify public API access and configure edge rate limits for the public checkout/quote routes for the expected traffic. A normal Chrome storefront check confirmed that the public catalog endpoint returns HTTP 200 JSON with the intended CORS header; the initial command-line health check was blocked by Cloudflare’s browser-signature policy. No checkout or supplier requests were made during the browser check.

Paid orders are durably queued before webhook acknowledgement. Supplier work uses a per-order lease, the order ID as Printful's external ID, a draft first, and a separate confirmation call. Before confirmation it checks exact variant/quantity, artwork identities, destination and supplier cost. If creation or confirmation times out, retries first retrieve the same external order instead of creating a new print order. Refunds, changed artwork/address or inconsistent amounts hold the order for owner review. Printful's [Orders and sync API documentation](https://developers.printful.com/docs/) defines the draft/confirmation and external-ID behavior used here.

Before enabling live checkout, the remaining concrete work is owner authorization/configuration of the existing Stripe account, the private Printful token and store ID, tax configuration and verification of Printful’s current delivery destinations, webhook registration, the actual return routes, and an approved end-to-end proof. No live commerce readiness is claimed while those are missing.

## Optional storefront measurement

Apply pending migrations including `0002_measurement.sql` to the existing dedicated Nino D1 database **before** deploying this release's Worker. Do not change database bindings or enable checkout/fulfillment as part of the migration.

`POST /api/measurement` accepts only five action names and an optional validated product ID. It requires the exact storefront origin, honors DNT/GPC headers, rejects additional fields, bounds request size, and stores only UTC day/mode/action/product aggregate totals. Unknown product IDs are skipped. The frontend sends actions only after an explicit browser opt-in; this is a browser privacy control, not cryptographic proof of consent against malicious clients. Counts are untrusted actions, never purchase proof. Daily caps limit stored counts, not incoming request costs. Retention cleanup runs on the six-hour schedule even without Printful credentials.

`GET /api/admin/measurement` uses the existing admin token and returns the last 30 days. Live confirmed purchases come from paid database rows with validated totals/payment intents and a first-observed timestamp. Test payments, unverified review-only rows and historical rows without a reliable timestamp do not count. The migration records that timestamp once so fulfillment retries cannot change purchase dates. Gross payment totals include shipping/tax, are not refund-adjusted net revenue, and cannot be divided by opt-in action counts to infer a population conversion rate.
