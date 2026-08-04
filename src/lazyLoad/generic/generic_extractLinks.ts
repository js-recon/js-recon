import * as cheerio from "cheerio";

const resolvePageUrl = (rawValue: string | undefined, baseUrl: string): string | null => {
    if (!rawValue) return null;
    const trimmed = rawValue.trim();
    if (!trimmed || trimmed.startsWith("#")) return null;
    if (/^(mailto|tel|javascript|data|blob):/i.test(trimmed)) return null;

    let resolved: URL;
    try {
        resolved = new URL(trimmed, baseUrl);
    } catch {
        return null;
    }
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") return null;

    resolved.hash = "";
    return resolved.href;
};

// Matches an absolute http(s) URL embedded anywhere in a string — e.g. inside an
// onclick handler's JS: onclick="return powerpress_pinw('https://site/?pinw=123')".
// Deliberately not tied to a specific function name (window.open, a plugin helper,
// etc.) — popup/widget links are triggered through all sorts of call shapes, but the
// URL argument itself is always a plain quoted absolute URL, which this catches
// regardless of what function it's passed to.
const EMBEDDED_URL_RE = /https?:\/\/[^\s'"<>)]+/g;

/**
 * Extracts every absolute http(s) URL substring embedded in a string value (typically
 * an onclick handler or other inline JS attribute). See EMBEDDED_URL_RE for why this
 * isn't tied to a specific JS call pattern like window.open(...).
 */
export const extractEmbeddedUrls = (attrValue: string): string[] =>
    [...attrValue.matchAll(EMBEDDED_URL_RE)].map((m) => m[0]);

/**
 * Extracts navigable page URLs from <a href>/<iframe src> tags and absolute URLs
 * embedded in any other attribute value (typically an onclick handler) — not JS
 * files. Used to recursively discover more HTML pages to scan for JS, per
 * internal#66. <iframe src> and onclick-embedded URLs are included alongside
 * <a href> because embedded widgets (a podcast player, a survey, a booking form) are
 * commonly reachable only via an iframe or a JS-driven popup, never a plain link —
 * WordPress's PowerPress podcast plugin is one real example: its "pop out player"
 * link is `onclick="return powerpress_pinw('https://site/?powerpress_pinw=123-podcast')"`,
 * invisible to href-only or iframe-only crawling. Filters out fragment-only links,
 * non-http(s) schemes (mailto/tel/javascript/data/blob), and strips the hash so
 * #section variants of the same page dedupe to one entry.
 */
export const extractPageLinks = (html: string, baseUrl: string): string[] => {
    const $ = cheerio.load(html);
    const links = new Set<string>();

    $("a[href], iframe[src]").each((_, elem) => {
        const rawValue = $(elem).attr("href") ?? $(elem).attr("src");
        const resolved = resolvePageUrl(rawValue, baseUrl);
        if (resolved) links.add(resolved);
    });

    $("*").each((_, elem) => {
        const attribs = (elem as any).attribs as Record<string, string> | undefined;
        if (!attribs) return;
        for (const [attrName, value] of Object.entries(attribs)) {
            // href/src already handled above via cheerio's typed accessors; re-scanning
            // them here would just re-add the same URL, which the Set dedupes anyway,
            // but skipping is cheaper and avoids false "embedded URL" matches inside a
            // long querystring value that itself contains another URL as a parameter.
            if (attrName === "href" || attrName === "src" || !value) continue;
            for (const embeddedUrl of extractEmbeddedUrls(value)) {
                const resolved = resolvePageUrl(embeddedUrl, baseUrl);
                if (resolved) links.add(resolved);
            }
        }
    });

    return [...links];
};

export default extractPageLinks;
