// Etsy listing title and tag changes for NinosTs, applied by the shop's scheduled runs (etsy.mjs runEtsy).
// One entry per listing: {listing_id, title?, tags?}. Etsy allows titles up to 140 characters and up to 13 tags of
// up to 20 characters each. Changing an entry's title or tags makes it apply again; removing an entry changes nothing
// on Etsy. Empty until the connection is live and the current listings have been read (/api/etsy/listings).
export const ETSY_LISTING_UPDATES = [];
