# Nino Battaglia

Graphic design portfolio and complete 137-shirt storefront. Static pages are in the repository root; all visual styles are in `main.css`. Native cart and checkout controls use `commerce.js`.

The complete 137-product catalog and optimized garment photos were verified against the authenticated Printful published catalog. Original full-resolution artwork stays in the artist’s source folder.

The separate `commerce-api/` Worker implements authoritative Printful variants and retail prices, Stripe Checkout, shipping quotes, payment webhooks, and paid-order fulfillment. Its server and order database are deployed at `https://nino-printful-commerce-api.ijpbattaglia.workers.dev`; the frontend uses that public endpoint. Stripe and Printful secrets, catalog synchronization, merchant tax settings, and the live Printful destination list still need verification before checkout can open. Follow its configuration instructions before opening checkout. Credentials are never included in browser files or source control.

Purchases stay in the site’s cart and use Stripe for payment; Etsy is not required by the buying flow. Current deployment is a review while payment/fulfillment connections and tax configuration are pending. The owner selected Printful-calculated shipping worldwide wherever Printful offers delivery. Do not enable purchases or claim a successful payment without the server’s verified readiness and paid-event handling.

Preserve `gallery.html` for existing portfolio links and `CNAME` for the GitHub Pages domain. `catalog.json` uses canonical Printful sync product IDs and locally optimized, verified garment images.
