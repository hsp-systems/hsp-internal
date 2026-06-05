// HSP Audit Worker — hsp-audit
// Proxies URL fetches and PageSpeed API calls server-side,
// then tries to detect Google Business Profile presence.

const ALLOWED_ORIGINS = [
  "https://hsp-systems.github.io",
  "https://hspsystems.io",
  "https://www.hspsystems.io",
  "http://localhost:8080",
  "http://127.0.0.1:8080",
];

function cors(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...extraHeaders },
  });
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 200, headers: cors(origin) });
    }

    const { pathname, searchParams } = new URL(request.url);
    const headers = cors(origin);

    if (pathname !== "/audit") {
      return json({ error: "Not found" }, 404, headers);
    }

    const rawUrl   = searchParams.get("url") || "";
    const bizName  = searchParams.get("biz") || "";
    const skipPsi  = searchParams.get("skippsi") === "1";

    // Validate URL
    let targetUrl;
    try {
      targetUrl = new URL(rawUrl);
      if (!["http:", "https:"].includes(targetUrl.protocol)) throw new Error("bad protocol");
    } catch {
      return json({ error: "Invalid or missing url parameter" }, 400, headers);
    }

    const result = {
      ok: false,
      isHTTPS: targetUrl.protocol === "https:",
      finalUrl: targetUrl.href,
      html: "",
      statusCode: 0,
      pagespeed: null,
      gmb: { found: false, rating: null, reviewCount: null },
    };

    // ── Run HTML, PageSpeed and GMB lookups in parallel ──────
    // Total latency ≈ the slowest task, not the sum of all three.

    // 1. Fetch site HTML
    const htmlTask = (async () => {
      try {
        const siteRes = await fetch(targetUrl.href, {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
              "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            Accept:
              "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
          },
          redirect: "follow",
          cf: { cacheTtl: 300 },
        });

        result.statusCode = siteRes.status;
        result.finalUrl   = siteRes.url;
        result.isHTTPS    = result.finalUrl.startsWith("https://");

        const ct = siteRes.headers.get("content-type") || "";
        if (siteRes.ok && ct.includes("text/html")) {
          // Cap to keep worker memory sane, but high enough to include the
          // footer/nav. Wix & Squarespace pages inline ~500KB-1MB of CSS/JS
          // BEFORE the links, so a low cap silently drops social/contact/nav.
          const buf  = await siteRes.arrayBuffer();
          result.html = new TextDecoder("utf-8", { fatal: false }).decode(
            buf.slice(0, 3_000_000)
          );
          result.ok = true;
        } else {
          result.htmlError = `HTTP ${siteRes.status} / content-type: ${ct}`;
        }
      } catch (e) {
        result.htmlError = e.message;
      }
    })();

    // 2. PageSpeed API (mobile) — skipped for fast GMB-only re-queries.
    //    An optional PSI_API_KEY secret avoids Google's anonymous 429 throttling.
    const psiTask = skipPsi ? Promise.resolve() : (async () => {
      try {
        const key = env && env.PSI_API_KEY ? `&key=${env.PSI_API_KEY}` : "";
        const psiRes = await fetch(
          `https://www.googleapis.com/pagespeedonline/v5/runPagespeed` +
            `?url=${encodeURIComponent(targetUrl.href)}` +
            `&strategy=mobile` +
            `&category=performance&category=seo&category=best-practices&category=accessibility` +
            key,
          { cf: { cacheTtl: 3600 } }
        );
        if (psiRes.ok) {
          result.pagespeed = await psiRes.json();
        } else {
          result.pagespeedError = `HTTP ${psiRes.status}`;
        }
      } catch (e) {
        result.pagespeedError = e.message;
      }
    })();

    // 3. Google Business Profile detection
    const gmbTask = bizName.trim() ? (async () => {
      try {
        const q   = encodeURIComponent(`${bizName.trim()} reviews`);
        const gRes = await fetch(
          `https://www.google.com/search?q=${q}&hl=en&gl=us`,
          {
            headers: {
              "User-Agent":
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
                "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
              Accept: "text/html",
              "Accept-Language": "en-US,en;q=0.9",
            },
            cf: { cacheTtl: 3600 },
          }
        );

        if (gRes.ok) {
          const gHtml = await gRes.text();
          const lower = gHtml.toLowerCase();

          // Look for Knowledge Panel signals
          const hasKP =
            lower.includes("kp-header") ||
            lower.includes("knowledge-panel") ||
            lower.includes("kp_wholepage") ||
            lower.includes("liuh0d") ||        // recent Google KP class
            lower.includes("google business");

          // Extract star rating — multiple patterns Google uses
          const ratingMatch =
            gHtml.match(/"ratingValue":\s*"?([\d.]+)/i) ||
            gHtml.match(/(\d\.\d)\s*(?:stars?|out\s+of\s+5)/i) ||
            gHtml.match(/aria-label="([\d.]+) stars?"/i);

          // Extract review count
          const reviewMatch =
            gHtml.match(/"reviewCount":\s*"?(\d[\d,]*)/i) ||
            gHtml.match(/([\d,]+)\s+(?:Google\s+)?reviews?/i);

          result.gmb.found       = hasKP || !!ratingMatch;
          result.gmb.rating      = ratingMatch  ? parseFloat(ratingMatch[1])                 : null;
          result.gmb.reviewCount = reviewMatch  ? parseInt(reviewMatch[1].replace(/,/g, "")) : null;
        }
      } catch (e) {
        result.gmb.error = e.message;
      }
    })() : Promise.resolve();

    await Promise.allSettled([htmlTask, psiTask, gmbTask]);

    return json(result, 200, headers);
  },
};
