/**
 * Distinguishes a Next.js dev server (`npm run dev`) from a production build, given a
 * cheerio-parsed document that has already matched `checkNextJS`. Dev-mode webpack emits
 * two markers not present in production chunk naming:
 * - a script `src` containing `/_next/static/chunks/node_modules_` (dev-mode vendor chunks)
 * - a script `src` whose pathname ends in `._.js`
 *
 * The `._.js` check is done against the URL's pathname via the `URL` constructor rather than
 * a raw substring/`endsWith` check on the full `src` string, so a query string or fragment
 * appended after `._.js` doesn't produce a false negative, and a malformed `src` doesn't
 * produce a false positive.
 */
import type { CheerioAPI } from "cheerio";

const isDevChunkPath = (raw: string, baseUrl: string): boolean => {
    if (raw.includes("/_next/static/chunks/node_modules_")) return true;
    try {
        return new URL(raw, baseUrl).pathname.endsWith("._.js");
    } catch {
        return false;
    }
};

export const isNextDevServer = ($: CheerioAPI, baseUrl: string, interceptedUrls: string[] = []): boolean => {
    let found = false;

    $("script, link").each((_, el) => {
        if (found) return;
        const src = $(el).attr("src") ?? $(el).attr("href");
        if (src && isDevChunkPath(src, baseUrl)) found = true;
    });
    if (found) return true;

    return interceptedUrls.some((u) => isDevChunkPath(u, baseUrl));
};
