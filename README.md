# Nino Battaglia

Graphic design portfolio and complete 136-shirt storefront. Static pages are in the repository root; all visual styles are in `main.css`. Native cart and checkout controls use `commerce.js`.

The complete 136-product catalog and optimized garment photos were verified against the authenticated Printful published catalog. Original full-resolution artwork stays in the artist’s source folder.

The separate `commerce-api/` Worker implements authoritative Printful variants and retail prices, Stripe Checkout, shipping quotes, payment webhooks, and paid-order fulfillment. Its server and order database are deployed at `https://nino-printful-commerce-api.ijpbattaglia.workers.dev`; the frontend uses that public endpoint. Stripe and Printful secrets, catalog synchronization, merchant tax settings, and the live Printful destination list still need verification before checkout can open. Follow its configuration instructions before opening checkout. Credentials are never included in browser files or source control.

Purchases stay in the site’s cart and use Stripe for payment; Etsy is not required by the buying flow. Current deployment is a review while payment/fulfillment connections and tax configuration are pending. The owner selected Printful-calculated shipping worldwide wherever Printful offers delivery. Do not enable purchases or claim a successful payment without the server’s verified readiness and paid-event handling.

Preserve `gallery.html` for existing portfolio links and `CNAME` for the GitHub Pages domain. `catalog.json` uses canonical Printful sync product IDs and locally optimized, verified garment images.

## Automatic Printful product additions

The storefront reads the completed Printful catalog on page load. Published products added to the configured Printful store appear after the scheduled six-hour sync finishes, without editing `catalog.json` or rebuilding the site. Sync batches resume every minute. This covers that store's published/synced products, not unpublished design templates or another Printful store.

The existing 136 verified designs remain the fallback until the first complete sync or during an API outage. A completed snapshot becomes authoritative, including removals. Existing curated photos and categories are retained for matching IDs; new designs use the supplier image. Designs without eligible variants remain visible with purchasing unavailable. Server-verified variants, prices and checkout readiness still control purchasing. A page refresh picks up a newly completed sync; browsing is not interrupted by background polling. If the API takes longer than three seconds, the page shows the fallback collection for that visit.

Activation still requires the private Printful token and selected store ID on the deployed commerce Worker. A saved browser sign-in does not supply an API token. Stripe, shipping and tax setup are separate requirements for accepting payments. No live payment or supplier order is authorized by this catalog change.

The October 17 requirement is independence from Etsy. Use a dedicated Printful Manual order/API store (`PRINTFUL_CATALOG_MODE=store`) as the continuing product source. Create/publish sellable products and their variants there; an unpublished design template alone is not an orderable product. The earlier Etsy-linked inventory is only the source of the already imported local reference catalog, not a required customer destination or runtime image host. Products must be configured in the independent store before its live sync can replace that reference catalog. Do not point the new store ID at the Etsy-linked store or silently turn on payment/fulfillment.

## Storefront completion work — October 17

`support.html` now provides sizing and garment-care guidance, delivery questions, order-issue instructions, and the site's current storage/measurement explanation. Every footer and product preview links to help. Garment dimensions, fabric composition, delivery promises, and refund eligibility have deliberately not been invented. Replace the contact-first guidance with confirmed per-garment information and merchant-approved terms before opening sales.

Search/category/sort choices persist in the URL for sharing or refresh. Product previews provide copyable product links, contextual sizing questions, clearer descriptions, and a fallback for failed images. Keyboard arrows in size/color inputs remain native. Narrow-screen controls retain the existing design and have larger touch targets. The sitemap includes public content/support pages; the cart is noindex, and old gallery links remain available. Product query links open the matching design; client-side product metadata is not a substitute for server-rendered product pages or crawler-specific social cards.

Optional measurement (`measurement.js`) starts off, requires a browser opt-in in Shop support → Your information, and honors DNT/GPC. It sends only an event name and, for product actions, a numeric product ID. The server stores daily UTC aggregate counts, not visitors or linked sessions. Test/live action datasets are separate. Confirmed live purchases come from verified order records, not browser events or the success URL. Counts can repeat and cannot establish a unique-visitor conversion rate; bot/ad-block/privacy effects and opt-in selection limit interpretation.

Before deploying this release's Worker, apply database migration `0002_measurement.sql` to the dedicated Nino commerce database. Static pages can deploy without the API update; measurement requests then fail quietly without affecting shopping. The existing checkout/fulfillment gates remain off. See `LAUNCH.md` for the remaining release work. No paid hosting or third-party analytics is required.
