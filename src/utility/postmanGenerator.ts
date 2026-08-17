import { OpenapiOutputItem } from "./globals.js";
import * as globalsUtil from "./globals.js";
import replacePlaceholders from "./replaceUrlPlaceholders.js";

/**
 * Postman Collection v2.1 — minimal subset of the schema we actually emit.
 *
 * Why this exists alongside the OpenAPI generator: OpenAPI tags are flat
 * strings and Bruno / Insomnia / Postman render them as a single level of
 * folders (often joining slashes with underscores). Postman Collection v2.1
 * has a recursive `item` array — a folder is just an item that contains more
 * items — so importers reproduce the URL path as a real directory tree.
 */
interface PMRequest {
    method: string;
    header: Array<{ key: string; value: string; type?: string }>;
    url: {
        raw: string;
        host: string[];
        path: string[];
        query?: Array<{ key: string; value: string }>;
        variable?: Array<{ key: string; value: string }>;
    };
    body?: {
        mode: "raw" | "none";
        raw?: string;
        options?: { raw: { language: "json" } };
    };
}

interface PMItem {
    name: string;
    description?: string;
    request?: PMRequest;
    item?: PMItem[];
}

interface PMCollection {
    info: {
        name: string;
        description?: string;
        schema: string;
        _postman_id?: string;
    };
    item: PMItem[];
    variable?: Array<{ key: string; value: string }>;
}

export const buildBodyExample = (rawBody: string): string | undefined => {
    if (!rawBody) return undefined;
    // The body strings we produce in traceBody.ts are JSON-ish but use
    // angle-bracketed placeholders for types (e.g. `"<string>"`). They are valid
    // JSON, so just pretty-print whatever parses.
    try {
        return JSON.stringify(JSON.parse(rawBody), null, 2);
    } catch {
        return rawBody;
    }
};

export const splitPath = (rawPath: string): { segments: string[]; query: Array<{ key: string; value: string }> } => {
    const [withoutQuery, queryString] = rawPath.split("?", 2);
    const segments = withoutQuery.split("/").filter(Boolean);
    const query: Array<{ key: string; value: string }> = [];
    if (queryString) {
        for (const part of queryString.split("&")) {
            const [k, v = ""] = part.split("=", 2);
            if (k) query.push({ key: decodeURIComponent(k), value: decodeURIComponent(v) });
        }
    }
    return { segments, query };
};

/**
 * Generates a Postman Collection v2.1 from the discovered endpoints, organising
 * them into nested folders that mirror the URL path. The first matching folder
 * is reused for sibling endpoints so importers don't end up with one folder per
 * request.
 *
 * Path parameters (`{id}`) are not used as folder names — they belong to a
 * specific endpoint, not the wider category — so when a segment is a path
 * variable we attach the operation directly to its parent folder and let the
 * request's full URL carry the variable.
 */
export const generatePostmanCollection = (items: OpenapiOutputItem[]): PMCollection => {
    const collection: PMCollection = {
        info: {
            name: "API Collection",
            description: "Endpoints discovered by js-recon, grouped by URL path.",
            schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
        },
        item: [],
        variable: [
            { key: "baseUrl", value: globalsUtil.getTargetUrl() || "https://example.com" },
            { key: "graphqlEndpoint", value: "graphql" },
        ],
    };

    // Tracks (folder-path) → existing PMItem so the second endpoint under the same folder and reuses it
    const folderIndex = new Map<string, PMItem>();
    folderIndex.set("", { name: "", item: collection.item } as PMItem);

    const ensureFolder = (folderSegments: string[]): PMItem => {
        let runningKey = "";
        let parent = folderIndex.get("") as PMItem;
        for (const segment of folderSegments) {
            runningKey = runningKey ? `${runningKey}/${segment}` : segment;
            let folder = folderIndex.get(runningKey);
            if (!folder) {
                folder = { name: segment, item: [] };
                (parent.item as PMItem[]).push(folder);
                folderIndex.set(runningKey, folder);
            }
            parent = folder;
        }
        return parent;
    };

    // Track repeat (path, method) occurrences so duplicate callsites get a
    // disambiguating suffix on their request name. We intentionally do NOT
    // skip duplicates here — each distinct callsite is preserved so a reviewer
    // can compare the headers/body shapes for the same endpoint.
    const callsiteCounts = new Map<string, number>();

    for (const item of items) {
        let rawPath = typeof item.path === "string" ? item.path : "";
        // If path is an absolute URL, extract just the pathname so we don't
        // prepend {{baseUrl}} to an already-complete URL.
        try {
            if (rawPath.startsWith("http://") || rawPath.startsWith("https://")) {
                const u = new URL(rawPath);
                rawPath = u.pathname + (u.search || "");
            }
        } catch {
            // leave rawPath as-is if URL parsing fails
        }
        const normalized = replacePlaceholders(rawPath.startsWith("/") ? rawPath : `/${rawPath}`);
        const method = typeof item.method === "string" ? item.method.toUpperCase() : "GET";
        const dedupeKey = `${method} ${normalized}`;
        const occurrenceIndex = callsiteCounts.get(dedupeKey) ?? 0;
        callsiteCounts.set(dedupeKey, occurrenceIndex + 1);

        const { segments, query } = splitPath(normalized);

        // Items with an explicit `collectionFolder` skip path-segment-derived
        // folder hierarchy and are placed flat under a single named folder.
        if (item.collectionFolder) {
            const folder = ensureFolder([item.collectionFolder]);
            const headers = Object.entries(item.headers || {}).map(([key, value]) => ({
                key,
                value: String(value),
                type: "text",
            }));
            // Convert OpenAPI-style `{name}` path params to Postman `:name`,
            // but leave `{{var}}` collection-variable placeholders untouched
            // (Postman substitutes those at request time).
            const pmUrlPath = segments.map((s) =>
                s.startsWith("{{") && s.endsWith("}}")
                    ? s
                    : s.startsWith("{") && s.endsWith("}")
                      ? `:${s.slice(1, -1)}`
                      : s
            );
            const request: PMRequest = {
                method,
                header: headers,
                url: {
                    raw: `{{baseUrl}}/${pmUrlPath.join("/")}${query.length > 0 ? "?" + query.map((q) => `${q.key}=${q.value}`).join("&") : ""}`,
                    host: ["{{baseUrl}}"],
                    path: pmUrlPath,
                    ...(query.length > 0 ? { query } : {}),
                },
            };
            if (item.body) {
                const bodyRaw = buildBodyExample(item.body) ?? item.body;
                request.body = {
                    mode: "raw",
                    raw: bodyRaw,
                    options: { raw: { language: "json" } },
                };
            } else {
                request.body = { mode: "none" };
            }
            const descParts: string[] = [];
            if (item.functionFile) {
                descParts.push(`Found in ${item.functionFile}:${item.functionFileLine}`);
            }
            (folder.item as PMItem[]).push({
                name: item.summary || `${method} request`,
                ...(descParts.length > 0 ? { description: descParts.join("\n") } : {}),
                request,
            });
            continue;
        }

        // Folder segments = all path segments except path-parameter segments.
        // A trailing `{id}` segment doesn't earn its own folder; we mount the
        // request on the parent.
        const folderSegments: string[] = [];
        const pathVars: Array<{ key: string; value: string }> = [];
        for (const seg of segments) {
            const isVar = seg.startsWith("{") && seg.endsWith("}");
            if (isVar) {
                pathVars.push({ key: seg.slice(1, -1), value: "" });
            } else {
                folderSegments.push(seg);
            }
        }
        // The leaf segment is the endpoint's own name; remove it from the
        // folder hierarchy so the request lands directly in its parent folder.
        const leaf = folderSegments.pop() ?? "";
        const folder = ensureFolder(folderSegments);

        const headers = Object.entries(item.headers || {}).map(([key, value]) => ({
            key,
            value: String(value),
            type: "text",
        }));

        const requestName = `${method} /${segments.join("/")}`;

        const pmUrlPath = segments.map((s) => (s.startsWith("{") && s.endsWith("}") ? `:${s.slice(1, -1)}` : s));

        const request: PMRequest = {
            method,
            header: headers,
            url: {
                raw: `{{baseUrl}}/${pmUrlPath.join("/")}${query.length > 0 ? "?" + query.map((q) => `${q.key}=${q.value}`).join("&") : ""}`,
                host: ["{{baseUrl}}"],
                path: pmUrlPath,
                ...(query.length > 0 ? { query } : {}),
                ...(pathVars.length > 0 ? { variable: pathVars } : {}),
            },
        };

        if (item.body && ["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
            const bodyRaw = buildBodyExample(item.body) ?? item.body;
            // Skip bodies that are empty objects — they only contain unresolvable spread artifacts.
            let isEmptyObject = false;
            try {
                const parsed = JSON.parse(bodyRaw);
                isEmptyObject =
                    typeof parsed === "object" &&
                    parsed !== null &&
                    !Array.isArray(parsed) &&
                    Object.keys(parsed).length === 0;
            } catch {}
            if (!isEmptyObject) {
                request.body = {
                    mode: "raw",
                    raw: bodyRaw,
                    options: { raw: { language: "json" } },
                };
            } else {
                request.body = { mode: "none" };
            }
        } else {
            request.body = { mode: "none" };
        }

        // Friendly request label — keep the leaf in the name to disambiguate
        // siblings under the same parent (e.g. invoices vs invoices/latest).
        // When an action name is available (e.g. Next.js Server Actions) it is
        // appended in parentheses and used as the primary disambiguator so
        // each entry is immediately identifiable without a bare counter.
        // For plain endpoints that share a path/method, a #N counter is kept.
        const leafName = leaf || segments[segments.length - 1] || "/";
        const disambig = item.summary ? ` (${item.summary})` : occurrenceIndex > 0 ? ` #${occurrenceIndex + 1}` : "";
        const descParts: string[] = [];
        if (item.functionFile) {
            descParts.push(`Defined in chunk ${item.chunkId} at ${item.functionFile}:${item.functionFileLine}`);
        }
        if (item.serverActionCallFile) {
            descParts.push(
                `Arguments from chunk ${item.serverActionCallChunkId} at ${item.serverActionCallFile}:${item.serverActionCallLine}`
            );
        }
        const itemEntry: PMItem = {
            name: `${method} ${leafName}${disambig}`,
            ...(descParts.length > 0 ? { description: descParts.join("\n") } : {}),
            request,
        };

        // If this URL has no folder segments at all (e.g. `/version`), put it
        // at the top level so it isn't lost.
        (folder.item as PMItem[]).push(itemEntry);
        // Suppress unused requestName lint warning — kept for future use.
        void requestName;
    }

    return collection;
};
