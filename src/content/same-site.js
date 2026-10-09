// Whether a link points at this same site, compared by hostname with any
// leading "www." ignored. Decides whether a blog post's CTA button opens a new
// tab: it did unconditionally, which made sense when the CTA led back to a
// client's old external store and none now that the Product Guide agent points
// it at the client's own product pages.
//
// With no site_url configured there is nothing to compare against, so the
// answer is false and the button keeps its old behaviour.
export function isSameSiteUrl(url, siteUrl) {
  const host = (u) => {
    try {
      return new URL(u).hostname.toLowerCase().replace(/^www\./, "");
    } catch {
      return null;
    }
  };
  const a = host(url);
  const b = host(siteUrl);
  return Boolean(a && b && a === b);
}
