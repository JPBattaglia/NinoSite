# Nino storefront release status — October 17, 2026

The implementation is on `codex/nino-studio-storefront`. This document describes prepared code, not a successful public release or live purchase.

## Prepared

- Existing 137 verified designs and 20 artworks retained; dynamic Printful additions remain supported after activation.
- Search, category and sort URL state, product links, image failure fallback, variant-input keyboard behavior, and narrow-screen help controls.
- Shop support page, contextual product questions, order-problem intake instructions, garment-specific sizing/care guidance without unverified measurements or materials.
- Public-page sitemap, accurate metadata and artist structured data; cart excluded from indexing. Existing gallery URL and domain configuration preserved.
- Optional anonymous daily action counts, no tracking identifiers, explicit browser opt-in, DNT/GPC, separate test/live counts, and protected server purchase report.

## Release order when account access is available

1. Confirm the dedicated independent Printful store and install its token/store ID in the existing Nino commerce Worker. Publish products there; the old Etsy-linked reference catalog does not automatically move designs into the independent store.
2. Apply D1 migrations to **nino-printful-commerce**, using the real tracked `commerce-api/wrangler.jsonc` configuration. The new migration adds aggregates and a first-verified-payment timestamp. Do not use a Menu-Made database. Do not recreate or replace the existing database. Apply only pending migrations.
3. Deploy the updated commerce Worker with checkout and fulfillment still disabled. Confirm public catalog readiness after a complete sync, available garment variants, actual product images and prices, and the shop support links.
4. Publish the static branch through the existing Nino domain deployment. Keep `CNAME`, the domain, original assets and old gallery links. Check apex and www handling, redirects/canonical host, HTTPS, cache refresh, and social previews. The apex is the configured checkout write origin.
5. Verify real garment size charts, materials, care instructions and merchant-approved shipping/return/privacy terms. The current support copy asks customers to contact Nino; it is not a finalized set of sales policies. Confirm destinations, shipping charges, tax settings, and order-support ownership.
6. Configure payment secrets and run test-mode checkout through signed webhooks, receipt recovery, address/rate validation, and failed/cancelled/retried payments. Test purchases must not create real Printful orders. Verify the measurement report excludes test purchases.
7. Independently verify on phone-sized and desktop screens: navigation, search/reset, filtering, sort, image previews, keyboard focus and Escape, size/color selection, unavailable variants, cart changes/persistence, empty/error states, and support contact links. A source/DOM check does not establish visual usability.
8. Only after a successful end-to-end test and confirmed merchant settings, open live checkout and fulfillment together. Verify one explicitly authorized real order before claiming the whole purchase/fulfillment flow works. No live order is authorized by this checklist.

## Measurement report

`GET /api/admin/measurement` requires the existing admin Bearer token. Keep it server-side; never put it into browser configuration or public pages. The response reports the last 30 UTC calendar days. Product actions reference only IDs present in the active catalog; they are skipped before a complete catalog exists. Counts are actions, not unique shoppers, linked sessions, or controlled experiments. The endpoint caps accepted actions at 10,000/day and 100/page in the browser; those caps bound stored totals, not infrastructure request volume.

Browser measurement starts off. The opt-in is under `support.html#privacy`; no network measurement is sent until the visitor opts in. DNT/GPC overrides the choice. Action aggregates use a rolling 90-day window and scheduled cleanup; regular commerce records have a separate operational retention policy still to be finalized. Test/live separation follows server payment mode. Verified purchase timestamps start with this migration and do not fabricate dates for historical orders. Purchase amounts include shipping/tax where charged, exclude unverified review-only payment rows, and are gross amounts rather than net/refund-adjusted revenue. Fulfillment updates do not move the recorded purchase day.

## Outstanding evidence

The public-domain switch, authenticated catalog sync, account-specific shipping/tax decisions, finalized policies, visual phone QA, and real/test payment-provider integration must be verified in the deployment environment. Local tests and a Worker dry-run do not prove those steps happened.

## Validation performed for this change

- 40 automated commerce/catalog/measurement tests passed, including origin/privacy guards, bounded payloads/counts, retention, authenticated reports, duplicate payment handling, and immutable payment-observation dates.
- 20 DOM/privacy interaction checks passed for search/reset/sort URLs, pagination, previews, product links, contextual support, image fallbacks, consent withdrawal, and GPC override. These used a simulated DOM and do not establish visual layout or real provider integration.
- Every internal page/asset reference and catalog photo reference resolved to a repository path across 137 products and 20 artworks.
- JavaScript syntax checks and the Worker deployment dry-run passed. The available browser could not reach the local preview, so visual phone QA remains pending.
