/**
 * Given a URL, returns an object with the host and directory
 * of the URL. The directory is the path of the URL after the
 * host, and the filename is removed if it ends with a file extension.
 * For example, given "https://vercel.com/static/js/main.js", it will return
 * an object with host "vercel.com" and directory "/static/js".
 * @param {string} url - The URL to parse.
 * @returns {Object} An object with the host and directory of the URL.
 */
export const toOutputHost = (host: string): string => {
    const normalized = host.normalize("NFKC").replace(/[^a-zA-Z0-9._\-[\]]/g, "_");
    const nonTraversing =
        normalized.length === 0 || /^\.+$/.test(normalized) ? normalized.replace(/\./g, "_") || "_" : normalized;
    const changed = nonTraversing !== host;
    const reservedLiteral = nonTraversing.startsWith(ENCODED_HOST_PREFIX);
    const needsBounding = nonTraversing.length > MAX_OUTPUT_HOST_LENGTH;
    if (!changed && !reservedLiteral && !needsBounding) return nonTraversing;

    const category = changed ? "encoded" : needsBounding ? "bounded" : "literal";
    const digest = createHash("sha256").update(host).digest("hex").slice(0, 12);
    const tagged = `${ENCODED_HOST_PREFIX}${category}_${nonTraversing}`;
    return `${tagged.slice(0, MAX_OUTPUT_HOST_LENGTH - digest.length - 1)}-${digest}`;
};

const canonicalNetworkHost = (host: string): string | null => {
    const candidate = host.trim();
    if (!candidate) return null;
    try {
        const parsed = new URL(candidate.includes("://") ? candidate : `http://${candidate}`);
        return parsed.host.toLowerCase();
    } catch {
        return null;
    }
};

/** Compares canonical network hosts without using lossy filesystem naming. */
export const hostMatchesScope = (host: string, scope: readonly string[]): boolean => {
    const canonicalHost = canonicalNetworkHost(host);
    if (!canonicalHost) return false;
    return scope.some((candidate) => candidate.trim() === "*" || canonicalNetworkHost(candidate) === canonicalHost);
};

const getURLDirectory = (url: string) => {
    const u = new URL(url);
    const pathname = u.pathname;

    // Remove filename (last part after final /) if it ends with .js or any file extension
    const dir = pathname.replace(/\/[^\/?#]+\.[^\/?#]+$/, "");

    return {
        host: toOutputHost(u.host), // e.g., "vercel.com" or "localhost_3000"
        rawHost: u.host,
        directory: dir, // e.g., "/static/js"
    };
};

export { getURLDirectory };
import { createHash } from "node:crypto";

const ENCODED_HOST_PREFIX = "__jsr_host_";
const MAX_OUTPUT_HOST_LENGTH = 180;

/**
 * Heuristic: only treat a resolved string as a URL if, after stripping every
 * `[…]` placeholder produced by the map resolvers, the remaining literal text
 * still contains a `/` separator or an explicit scheme. This rejects calls on
 * Map/Set/Headers/EventBus (`x.get("key")`, `bus.post(event)`) while keeping
 * partial URLs like `[call:base()]<literal>/[param:e]/[param:t]`.
 */
export const looksLikeUrl = (s: string): boolean => {
    if (!s) return false;
    if (s.startsWith("http://") || s.startsWith("https://")) return true;
    const stripped = s.replace(/\[[^\]]*\]/g, "");
    return stripped.includes("/");
};

/**
 * Stricter check used for fetch / XHR URLs: rejects anything that starts with a
 * `[…]` placeholder and requires a scheme, a leading `/`, or a leading `segment/`.
 * Drops inner wrapper bodies like `fetch(i, l)` (where `i` is a param) and
 * non-string AST nodes that have no chance of being a real path.
 */
export const looksLikeStrictUrl = (url: string): boolean =>
    url.length > 0 &&
    !url.startsWith("[") &&
    url !== "[object Object]" &&
    (url.startsWith("http://") || url.startsWith("https://") || url.startsWith("/") || /^[A-Za-z0-9_\-.]+\//.test(url));
