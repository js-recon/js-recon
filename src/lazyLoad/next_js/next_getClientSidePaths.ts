import { printMsg, MSG } from "../../utility/printMsg.js";
import * as cheerio from "cheerio";
import { URL } from "url";
import makeRequest from "../../utility/makeReq.js";

/**
 * Extracts client-side paths from a page's HTML by parsing <a href> tags.
 *
 * Only returns URLs that share the base URL's origin. Accepted href forms:
 *   - root-relative (`/foo/bar`)
 *   - relative (`./foo`, `../foo`, `foo`)
 *   - absolute (`https://same-origin/foo`)
 *
 * Skips mailto:, tel:, javascript:, data:, protocol-relative (`//`), and
 * fragment-only links.
 */
const next_getClientSidePaths = async (url: string): Promise<string[]> => {
    const found = new Set<string>();

    let baseOrigin: string;
    try {
        baseOrigin = new URL(url).origin;
    } catch {
        return [];
    }

    const req = await makeRequest(url);
    if (!req || !req.ok) return [];

    let html: string;
    try {
        html = await req.text();
    } catch {
        return [];
    }

    const $ = cheerio.load(html);

    $("a[href]").each((_, a) => {
        const href = $(a).attr("href");
        if (!href) return;

        const trimmed = href.trim();
        if (!trimmed) return;

        if (
            trimmed.startsWith("#") ||
            trimmed.startsWith("//") ||
            trimmed.startsWith("mailto:") ||
            trimmed.startsWith("tel:") ||
            trimmed.startsWith("javascript:") ||
            trimmed.startsWith("data:")
        ) {
            return;
        }

        const isRootRelative = trimmed.startsWith("/");
        const isRelative = trimmed.startsWith(".") || /^[a-zA-Z0-9_\-]/.test(trimmed);
        const isAbsolute = /^https?:\/\//i.test(trimmed);

        if (!isRootRelative && !isRelative && !isAbsolute) return;

        let resolved: URL;
        try {
            resolved = new URL(trimmed, url);
        } catch {
            return;
        }

        if (resolved.origin !== baseOrigin) return;

        resolved.hash = "";
        found.add(resolved.href);
    });

    if (found.size > 0) {
        printMsg(MSG.Run, `[✓] Found ${found.size} client-side path(s) on ${url}`);
    }

    return [...found];
};

export default next_getClientSidePaths;
