/**
 * Distinguishes a SvelteKit dev server (`npm run dev`, always Vite-based — SvelteKit has no
 * webpack dev-server tool-chain) from a production build, given a cheerio-parsed document
 * that has already matched `checkSvelte`.
 *
 * Unlike Vue/React, SvelteKit's dev server does **not** inject a `<script type="module"
 * src="/@vite/client">` tag into the served HTML at all (confirmed live: SvelteKit's SSR
 * render pipeline only emits the app's own hydration `<script>` block). The reliable marker is
 * instead the `__sveltekit_dev` global that SvelteKit's dev-mode client bootstrap assigns
 * inside that inline `<script>` block — a literal that never appears in a production build's
 * output (`svelte_getFromPageSource.ts` already scans this same block for its `import(...)`
 * boot paths). `/@vite/client` is checked too (script/link `src`/`href`, or an intercepted
 * request URL) as a secondary signal for target setups that do request it directly — but on
 * its own it only proves "some Vite dev server", not specifically Svelte, which is why it's
 * only ever consulted after `checkSvelte` has already matched.
 *
 * All pathname checks are done via the `URL` constructor rather than raw substring/`endsWith`
 * checks on the full `src`/`href` string, so a query string or fragment appended after a marker
 * doesn't produce a false negative, and a malformed value doesn't produce a false positive.
 */
import type { CheerioAPI } from "cheerio";

const isViteClientPath = (raw: string, baseUrl: string): boolean => {
    try {
        return new URL(raw, baseUrl).pathname === "/@vite/client";
    } catch {
        return false;
    }
};

export const isSvelteDevServer = ($: CheerioAPI, baseUrl: string, interceptedUrls: string[] = []): boolean => {
    let found = false;

    $("script:not([src])").each((_, el) => {
        if (found) return;
        const body = $(el).text();
        if (body && body.includes("__sveltekit_dev")) found = true;
    });
    if (found) return true;

    $("script, link").each((_, el) => {
        if (found) return;
        const src = $(el).attr("src") ?? $(el).attr("href");
        if (src && isViteClientPath(src, baseUrl)) found = true;
    });
    if (found) return true;

    return interceptedUrls.some((u) => isViteClientPath(u, baseUrl));
};
