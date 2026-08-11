export type DownloadResponseFailure = "download" | "invalidResponse";
export type DownloadedAssetKind = "javascript" | "json" | "vue";

export type DownloadResponseResult =
    Readonly<{ ok: true; body: string }> | Readonly<{ ok: false; failure: DownloadResponseFailure; reason: string }>;

const JAVASCRIPT_CONTENT_TYPES = new Set([
    "application/ecmascript",
    "application/javascript",
    "application/x-ecmascript",
    "application/x-javascript",
    "text/ecmascript",
    "text/javascript",
    "text/javascript1.0",
    "text/javascript1.1",
    "text/javascript1.2",
    "text/javascript1.3",
    "text/javascript1.4",
    "text/javascript1.5",
    "text/jscript",
    "text/livescript",
    "text/x-ecmascript",
    "text/x-javascript",
]);

const GENERIC_CODE_CONTENT_TYPES = new Set(["application/octet-stream", "binary/octet-stream", "text/plain"]);
const VUE_CONTENT_TYPES = new Set(["application/x-vue", "text/x-vue"]);

const downloadPathname = (url: string): string => {
    try {
        return new URL(url).pathname.toLowerCase();
    } catch {
        return url.split(/[?#]/, 1)[0].toLowerCase();
    }
};

export const getDownloadedAssetKind = (url: string): DownloadedAssetKind => {
    const pathname = downloadPathname(url);
    if (/(?:\.json|\.m?js\.map)$/.test(pathname)) return "json";
    if (pathname.endsWith(".vue")) return "vue";
    return "javascript";
};

const hasCompatibleContentType = (url: string, rawContentType: string | null): boolean => {
    if (!rawContentType) return true;

    const contentType = rawContentType.split(";", 1)[0].trim().toLowerCase();
    if (!contentType || GENERIC_CODE_CONTENT_TYPES.has(contentType)) return true;

    const assetKind = getDownloadedAssetKind(url);
    if (assetKind === "json") {
        // eslint-disable-next-line security/detect-unsafe-regex -- anchored, no nested/ambiguous quantifiers — not exploitable
        return contentType === "text/json" || /^application\/(?:[a-z0-9.+-]+\+)?json$/.test(contentType);
    }
    if (assetKind === "vue") {
        // Some development servers serve SFC source as text/html. The body
        // check below distinguishes an SFC from a complete HTML fallback.
        return VUE_CONTENT_TYPES.has(contentType) || contentType === "text/html";
    }
    return JAVASCRIPT_CONTENT_TYPES.has(contentType);
};

const looksLikeHtmlDocument = (body: string): boolean => {
    const prefix = body
        .replace(/^\uFEFF/, "")
        .trimStart()
        .slice(0, 1024);
    return /^(?:<!doctype\s+html\b|<html(?:\s|>)|<head(?:\s|>)|<body(?:\s|>))/i.test(prefix);
};

/**
 * Validates a fetched code asset before it reaches Prettier. Missing and
 * generic MIME types are accepted because many CDNs serve valid bundles with
 * incomplete metadata; explicitly incompatible types and HTML fallbacks are
 * rejected.
 */
export const readDownloadedAssetResponse = async (url: string, response: Response): Promise<DownloadResponseResult> => {
    if (!response.ok) {
        return Object.freeze({
            ok: false,
            failure: "invalidResponse",
            reason: `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`,
        });
    }

    const contentType = response.headers.get("content-type");
    if (!hasCompatibleContentType(url, contentType)) {
        return Object.freeze({
            ok: false,
            failure: "invalidResponse",
            reason: `unexpected content type ${contentType}`,
        });
    }

    let body: string;
    try {
        body = await response.text();
    } catch (err) {
        return Object.freeze({
            ok: false,
            failure: "download",
            reason: `could not read response body: ${err}`,
        });
    }

    if (looksLikeHtmlDocument(body)) {
        return Object.freeze({
            ok: false,
            failure: "invalidResponse",
            reason: "received an HTML document instead of a code asset",
        });
    }

    return Object.freeze({ ok: true, body });
};
