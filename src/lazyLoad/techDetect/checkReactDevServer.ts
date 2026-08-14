/**
 * Distinguishes a React dev server (Vite `npm run dev`, or CRA/`react-scripts start`/custom
 * `webpack-dev-server`) from a production build, given a cheerio-parsed document that has
 * already matched `checkReact`. Two independent bundler tool-chains emit different dev-mode
 * markers:
 *
 * - **Vite** — reuses the same markers already in `checkReact.ts`'s `REACT_MARKERS` /
 *   `/@react-refresh` fast path: an inline `<script>` containing `@react-refresh` or
 *   `injectIntoGlobalHook`, or a script `src`/intercepted URL whose pathname is
 *   `/@react-refresh`. Live-validated against `js-recon-research/react/{vuln_app,20-cve-app}`.
 * - **webpack** (`webpack-dev-server`, CRA's `react-scripts start` included) — unlike Vite's
 *   markers, these only appear inside the *content* of the bundled entry script, not in HTML
 *   attributes or URL paths (confirmed live against
 *   `js-recon-research/react/vuln_app_webpack`, a custom `webpack-dev-server` config): the
 *   bundle embeds `webpack-dev-server/client` module-comment paths, `webpackHotUpdate` runtime
 *   calls, and `[HMR]` log-prefixed strings. A same-origin fetch of each referenced `<script
 *   src>` is required to see them — same fetch-and-scan pattern `checkReact.ts`'s
 *   `fetchAndCheck` already uses for its own production markers, just against a different
 *   marker set. (The legacy webpack-dev-server v3 `/sockjs-node/` WebSocket path and
 *   unhashed-filename heuristic don't hold for v4/v5, which defaults to a `/ws` WebSocket path
 *   and lets `output.filename` still contain `[contenthash]` in dev mode — so this only checks
 *   bundle content, not those older path-shape signals.)
 *
 * All pathname checks go through the `URL` constructor rather than a raw substring check, same
 * convention as `checkNextDevServer.ts` / `checkVueDevServer.ts`.
 */
import type { CheerioAPI } from "cheerio";
import makeRequest from "../../utility/makeReq.js";

const WEBPACK_DEV_MARKERS = ["webpack-dev-server/client", "webpackHotUpdate", "[HMR]"] as const;

const pathnameOf = (raw: string, baseUrl: string): string | undefined => {
    try {
        return new URL(raw, baseUrl).pathname;
    } catch {
        return undefined;
    }
};

const isReactRefreshPath = (raw: string, baseUrl: string): boolean => pathnameOf(raw, baseUrl) === "/@react-refresh";

const matchesViteDevMarkers = ($: CheerioAPI, baseUrl: string, interceptedUrls: string[]): boolean => {
    let found = false;

    $("script:not([src])").each((_, el) => {
        if (found) return;
        const body = $(el).text();
        if (body && (body.includes("@react-refresh") || body.includes("injectIntoGlobalHook"))) found = true;
    });
    if (found) return true;

    $("script, link").each((_, el) => {
        if (found) return;
        const src = $(el).attr("src") ?? $(el).attr("href");
        if (src && isReactRefreshPath(src, baseUrl)) found = true;
    });
    if (found) return true;

    return interceptedUrls.some((u) => isReactRefreshPath(u, baseUrl));
};

const matchesWebpackDevMarkers = async ($: CheerioAPI, baseUrl: string): Promise<boolean> => {
    const origin = (() => {
        try {
            return new URL(baseUrl).origin;
        } catch {
            return null;
        }
    })();
    if (!origin) return false;

    const scriptSrcs = $("script[src]")
        .get()
        .map((el) => $(el).attr("src"))
        .filter((src): src is string => !!src);

    for (const src of scriptSrcs) {
        let resolvedUrl: string;
        try {
            resolvedUrl = new URL(src, baseUrl).href;
        } catch {
            continue;
        }
        try {
            if (new URL(resolvedUrl).origin !== origin) continue;
        } catch {
            continue;
        }

        const res = await makeRequest(resolvedUrl, {});
        if (!res) continue;
        const body = await res.text();
        if (WEBPACK_DEV_MARKERS.some((marker) => body.includes(marker))) return true;
    }

    return false;
};

export const isReactDevServer = async (
    $: CheerioAPI,
    baseUrl: string,
    interceptedUrls: string[] = []
): Promise<boolean> => {
    if (matchesViteDevMarkers($, baseUrl, interceptedUrls)) return true;
    return matchesWebpackDevMarkers($, baseUrl);
};
