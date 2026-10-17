# Nino Battaglia

Graphic design portfolio and complete137-shirt storefront. Static pages are in the repository root; all visual styles are in `main.css`. Native cart and checkout controls use `commerce.js`.

The complete137-product catalog and optimized garment photos were verified against the authenticated Printful published catalog. Original full-resolution artwork stays in the artist’s source folder.

The separate `commerce-api/` Worker implements authoritative Printful variants and retail prices, Stripe Checkout, shipping quotes, payment webhooks, and paid-order fulfillment. Follow its configuration instructions before opening checkout. Credentials are never included in browser files or source control.

Purchases stay in the site’s cart and use Stripe for payment; Etsy is not required by the buying flow. Current deployment is a review while payment/fulfillment connections and shipping configuration are pending. Do not enable purchases or claim a successful payment without the server’s verified readiness and paid-event handling.

Preserve `gallery.html` for existing portfolio links and `CNAME` for the GitHub Pages domain. `catalog.json` uses canonical Printful sync product IDs and locally optimized, verified garment images.
