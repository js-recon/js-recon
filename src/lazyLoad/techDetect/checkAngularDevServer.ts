/**
 * Distinguishes an Angular dev server (`ng serve`) from a production build, given a
 * cheerio-parsed document that has already matched `checkAngularJS`. Angular CLI has shipped
 * two structurally different dev-server implementations depending on the builder in use:
 *
 * - **`@angular-devkit/build-angular:application` / `@angular/build:application`** (Angular 17+
 *   esbuild-based builder, the default since Angular CLI 17 and the only builder available in
 *   the 4 Angular research apps in the workspace): dev serving runs through Vite in middleware
 *   mode, emitting the exact same markers a stock Vite dev server does — a
 *   `<script type="module" src="/@vite/client">` tag, and `import.meta.hot` /
 *   `__vite__createHotContext` references inside the served entry chunk. Confirmed live against
 *   a running `ng serve` on this builder (Angular 19).
 * - **`@angular-devkit/build-angular:browser` / `:browser-esbuild`** (the pre-17 default,
 *   webpack-dev-server-based): implemented from the dev-server tooling's documented/known output
 *   shape — a `webpack-dev-server/client` reference in a script src or inline script, a
 *   `/sockjs-node/` HMR WebSocket path, or an unhashed entry filename (`main.js`, `polyfills.js`,
 *   `vendor.js`, `runtime.js`) where a production build would emit a content-hashed name
 *   instead. Not live-validated — no `:browser`-builder Angular app exists in the research
 *   workspace (every available Angular test app already defaults to the esbuild builder), same
 *   situation as `checkVueDevServer.ts`'s webpack/`vue-cli` markers.
 *
 * All pathname checks are done via the `URL` constructor rather than raw substring/`endsWith`
 * checks on the full `src`/`href` string, so a query string or fragment appended after a marker
 * doesn't produce a false negative, and a malformed value doesn't produce a false positive.
 */
import type { CheerioAPI } from "cheerio";

const UNHASHED_WEBPACK_ENTRY_NAMES = new Set(["main.js", "polyfills.js", "vendor.js", "runtime.js"]);

const pathnameOf = (raw: string, baseUrl: string): string | undefined => {
    try {
        return new URL(raw, baseUrl).pathname;
    } catch {
        return undefined;
    }
};

const isViteClientPath = (raw: string, baseUrl: string): boolean => pathnameOf(raw, baseUrl) === "/@vite/client";

const isSockjsNodePath = (raw: string, baseUrl: string): boolean => {
    const pathname = pathnameOf(raw, baseUrl);
    return pathname !== undefined && pathname.includes("/sockjs-node/");
};

const isUnhashedWebpackEntryPath = (raw: string, baseUrl: string): boolean => {
    const pathname = pathnameOf(raw, baseUrl);
    if (pathname === undefined) return false;
    const basename = pathname.split("/").pop() ?? "";
    return UNHASHED_WEBPACK_ENTRY_NAMES.has(basename);
};

export const isAngularDevServer = ($: CheerioAPI, baseUrl: string, interceptedUrls: string[] = []): boolean => {
    let found = false;

    $("script, link").each((_, el) => {
        if (found) return;
        const src = $(el).attr("src") ?? $(el).attr("href");
        if (!src) return;
        if (
            isViteClientPath(src, baseUrl) ||
            isSockjsNodePath(src, baseUrl) ||
            isUnhashedWebpackEntryPath(src, baseUrl)
        ) {
            found = true;
        }
    });
    if (found) return true;

    $("script:not([src])").each((_, el) => {
        if (found) return;
        const body = $(el).text();
        if (body && (body.includes("import.meta.hot") || body.includes("webpack-dev-server/client"))) found = true;
    });
    if (found) return true;

    return interceptedUrls.some((u) => isViteClientPath(u, baseUrl) || isSockjsNodePath(u, baseUrl));
};
