// HuggingFace bucket client for CS-MAST-S signature retrieval.
// All remote interaction is isolated here so the storage backend can be swapped
// without touching the rest of the refactor pipeline.

export const HF_BUCKET = "shriyanss/cs-mast-s-dataset";

// Maps refactor tech identifier to the HuggingFace bucket path prefix that holds its signatures.
export const TECH_TO_BRANCH: Record<string, string> = {
    "react-webpack": "react/webpack/large-0.1.8",
    "react-vite": "react/vite/large-0.1.8",
    "next-webpack": "next/webpack/large-0.1.8",
    "next-turbopack": "next/turbopack/large-0.1.8",
};

export type CollisionRecord = {
    signature: string;
    count: number;
    files: string[];
};

type HfTreeEntry = {
    type: "file" | "directory";
    path: string;
    size?: number;
    xetHash?: string;
};

// --- URL builders ---

// Bucket resolve URL: fetches raw file content.
// The full path (prefix + subpath) is URL-encoded as one component per the bucket API contract.
export const getHfRawUrl = (prefix: string, subpath: string): string => {
    const fullPath = encodeURIComponent(`${prefix}/${subpath}`);
    return `https://huggingface.co/buckets/${HF_BUCKET}/resolve/${fullPath}`;
};

// Bucket tree URL: lists immediate children of a prefix (non-recursive by default).
// Returns items whose `path` field is the full path from bucket root.
export const getHfApiTreeUrl = (prefix: string): string =>
    `https://huggingface.co/api/buckets/${HF_BUCKET}/tree/${encodeURIComponent(prefix)}`;

// --- Low-level fetch helpers ---

// Returns the response text, or null on 404 / non-OK responses.
// Throws on HTTP 429 (rate limit) so callers can surface the error.
export const fetchText = async (url: string): Promise<string | null> => {
    let resp: Response;
    try {
        resp = await fetch(url);
    } catch (e) {
        return null;
    }
    if (resp.status === 429) throw new Error(`Rate limited by HuggingFace (url: ${url})`);
    if (!resp.ok) return null;
    return resp.text();
};

// --- Branch metadata ---

export const getSampleSize = async (branch: string): Promise<number> => {
    const text = await fetchText(getHfRawUrl(branch, "sample_size"));
    if (text === null) throw new Error(`Branch "${branch}": could not fetch sample_size`);
    const n = parseInt(text.trim(), 10);
    if (isNaN(n)) throw new Error(`Branch "${branch}": sample_size is not a number ("${text.trim()}")`);
    return n;
};

export const getTechnology = async (branch: string): Promise<string> => {
    const text = await fetchText(getHfRawUrl(branch, "technology"));
    if (text === null) throw new Error(`Branch "${branch}": could not fetch technology`);
    return text.trim();
};

// Validates that the remote branch has the required metadata files.
// Returns true when valid, false when either file is missing/unreachable.
export const validateRemoteBranch = async (branch: string): Promise<boolean> => {
    const [sampleSizeText, technologyText] = await Promise.all([
        fetchText(getHfRawUrl(branch, "sample_size")),
        fetchText(getHfRawUrl(branch, "technology")),
    ]);
    return sampleSizeText !== null && technologyText !== null;
};

// Validates that a bucket path exists by checking the tree API returns at least one entry.
// Use this for user-supplied paths that may not have metadata files.
export const validateRemotePath = async (prefix: string): Promise<boolean> => {
    const url = getHfApiTreeUrl(prefix);
    let resp: Response;
    try {
        resp = await fetch(url);
    } catch {
        return false;
    }
    if (resp.status === 429) throw new Error(`Rate limited by HuggingFace (url: ${url})`);
    if (!resp.ok) return false;
    try {
        const text = await resp.text();
        const entries = JSON.parse(text) as unknown[];
        return Array.isArray(entries) && entries.length > 0;
    } catch {
        return false;
    }
};

// --- File listing ---

// Extracts the next-page URL from a `Link: <url>; rel="next"` header, or null if absent.
const parseNextLink = (linkHeader: string | null): string | null => {
    if (!linkHeader) return null;
    const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
    return match ? match[1] : null;
};

// Lists feature subdirectory names immediately under a bucket prefix.
// The bucket tree API returns a flat list of file entries (no directory-type entries) and
// paginates at 1000 entries. We follow Link: rel="next" headers to collect all pages, then
// extract unique first-level path segments from all file paths after stripping the prefix.
const listTopLevelDirs = async (prefix: string): Promise<string[]> => {
    const dirs = new Set<string>();
    const prefixSlash = prefix.endsWith("/") ? prefix : `${prefix}/`;
    let url: string | null = getHfApiTreeUrl(prefix);

    while (url) {
        let resp: Response;
        try {
            resp = await fetch(url);
        } catch {
            break;
        }
        if (resp.status === 429) throw new Error(`Rate limited by HuggingFace (url: ${url})`);
        if (!resp.ok) break;

        const text = await resp.text();
        try {
            const entries = JSON.parse(text) as HfTreeEntry[];
            for (const e of entries) {
                const rel = e.path.startsWith(prefixSlash) ? e.path.slice(prefixSlash.length) : e.path;
                const parts = rel.split("/");
                // Only treat as a feature dir if the entry is nested (parts.length > 1),
                // skipping top-level files like sample_size, technology, README.md.
                if (parts.length > 1 && parts[0]) dirs.add(parts[0]);
            }
        } catch {
            break;
        }

        url = parseNextLink(resp.headers.get("link"));
    }

    return Array.from(dirs);
};

// Returns relative paths of all collisions.json files under `<featureDir>/<scatDir>/collisions.json`
// for every top-level feature directory in the branch. Does NOT require recursive tree traversal.
export const listCollisionsFiles = async (branch: string, scatDir: string): Promise<string[]> => {
    const featureDirs = await listTopLevelDirs(branch);
    return featureDirs.map((dir) => `${dir}/${scatDir}/collisions.json`);
};

// Returns a map of relative `<feature>/<scatDir>/collisions.json` path -> remote content hash
// (`xetHash`) for every matching file under a branch. This is the upstream-change detection
// signal: two calls with different results for the same subpath mean the dataset content
// changed, regardless of how recently the local cache entry was written. Paginates the same
// way as `listTopLevelDirs`.
export const listCollisionsFileHashes = async (branch: string, scatDir: string): Promise<Map<string, string>> => {
    const hashes = new Map<string, string>();
    const prefixSlash = branch.endsWith("/") ? branch : `${branch}/`;
    let url: string | null = getHfApiTreeUrl(branch);

    while (url) {
        let resp: Response;
        try {
            resp = await fetch(url);
        } catch {
            break;
        }
        if (resp.status === 429) throw new Error(`Rate limited by HuggingFace (url: ${url})`);
        if (!resp.ok) break;

        const text = await resp.text();
        try {
            const entries = JSON.parse(text) as HfTreeEntry[];
            for (const e of entries) {
                if (e.type !== "file" || !e.xetHash) continue;
                if (!e.path.endsWith(`/${scatDir}/collisions.json`)) continue;
                const rel = e.path.startsWith(prefixSlash) ? e.path.slice(prefixSlash.length) : e.path;
                hashes.set(rel, e.xetHash);
            }
        } catch {
            break;
        }

        url = parseNextLink(resp.headers.get("link"));
    }

    return hashes;
};

// Fetches and parses a collisions.json from a raw HF URL.
// Returns null on 404 / non-OK; throws on rate limit.
export const fetchCollisionsJson = async (url: string): Promise<CollisionRecord[] | null> => {
    const text = await fetchText(url);
    if (text === null) return null;
    try {
        return JSON.parse(text) as CollisionRecord[];
    } catch {
        return null;
    }
};
