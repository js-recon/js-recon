/**
 * Distinguishes a Nuxt dev server (`nuxi dev` / `nuxt` for Nuxt 2) from a production build, given a
 * cheerio-parsed document that has already matched `checkNuxtJS`. Nuxt's dev-server tool-chain
 * depends on its major version:
 *
 * - **Nuxt 3/4** (Vite-powered dev server): a `<script type="module" src="...">` tag whose pathname
 *   is `/_nuxt/@vite/client` — Nuxt's own `/_nuxt/`-prefixed Vite client path, distinct from vanilla
 *   Vite's root `/@vite/client` (`checkVueDevServer.ts`'s marker). Confirmed live against every Nuxt
 *   3/4 app in the research workspace. `window.__NUXT_DEVTOOLS_TIME_METRIC__` in an inline script is
 *   a secondary signal — only present when `devtools.enabled` is `true` (Nuxt DevTools defaults to
 *   enabled, but apps that disable it won't show this), so it's checked in addition to, never instead
 *   of, the `@vite/client` marker. `import.meta.hot` was never observed inline in any tested app (it
 *   lives inside the Vite client module itself) — kept as a defensive fallback only, matching
 *   `checkVueDevServer.ts`'s equivalent caveat for its own Vite branch.
 * - **Nuxt 2** (webpack dev server): an unhashed entry filename (`_nuxt/app.js`) where a production
 *   build emits a content-hashed name instead — confirmed live. A `/__webpack_hmr` pathname (the
 *   webpack-hot-middleware SSE endpoint Nuxt 2's client runtime opens at runtime) is also confirmed
 *   live, but only observable via `interceptedUrls` (a plain HTML/fetch scan won't see it — the
 *   request is made by client-side JS after the page loads). An inline `<script>` body containing
 *   `webpackHotUpdate` is kept as a defensive fallback matching `checkVueDevServer.ts`'s webpack
 *   branch — in practice this literal lives inside the separately-loaded `runtime.js` chunk for
 *   Nuxt 2, not inline HTML, so it's unlikely to fire on its own.
 *
 * All pathname checks are done via the `URL` constructor rather than raw substring/`endsWith` checks
 * on the full `src`/`href` string, so a query string or fragment appended after a marker doesn't
 * produce a false negative, and a malformed value doesn't produce a false positive.
 */
import type { CheerioAPI } from "cheerio";

const pathnameOf = (raw: string, baseUrl: string): string | undefined => {
    try {
        return new URL(raw, baseUrl).pathname;
    } catch {
        return undefined;
    }
};

const isNuxtViteClientPath = (raw: string, baseUrl: string): boolean =>
    pathnameOf(raw, baseUrl) === "/_nuxt/@vite/client";

const isWebpackHmrPath = (raw: string, baseUrl: string): boolean => {
    const pathname = pathnameOf(raw, baseUrl);
    return pathname !== undefined && /(?:^|\/)__webpack_hmr(?:\/|$)/.test(pathname);
};

const isUnhashedNuxt2EntryPath = (raw: string, baseUrl: string): boolean => {
    const pathname = pathnameOf(raw, baseUrl);
    if (pathname === undefined) return false;
    return pathname.endsWith("/_nuxt/app.js");
};

export const isNuxtDevServer = ($: CheerioAPI, baseUrl: string, interceptedUrls: string[] = []): boolean => {
    let found = false;

    $("script, link").each((_, el) => {
        if (found) return;
        const src = $(el).attr("src") ?? $(el).attr("href");
        if (!src) return;
        if (
            isNuxtViteClientPath(src, baseUrl) ||
            isWebpackHmrPath(src, baseUrl) ||
            isUnhashedNuxt2EntryPath(src, baseUrl)
        ) {
            found = true;
        }
    });
    if (found) return true;

    $("script:not([src])").each((_, el) => {
        if (found) return;
        const body = $(el).text();
        if (
            body &&
            (body.includes("__NUXT_DEVTOOLS_TIME_METRIC__") ||
                body.includes("import.meta.hot") ||
                body.includes("webpackHotUpdate"))
        ) {
            found = true;
        }
    });
    if (found) return true;

    return interceptedUrls.some((u) => isNuxtViteClientPath(u, baseUrl) || isWebpackHmrPath(u, baseUrl));
};
