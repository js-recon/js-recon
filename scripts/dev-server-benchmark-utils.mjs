/**
 * Pure URL-normalization helpers for dev-server-benchmark.mjs, split into their own
 * side-effect-free module so they can be unit tested without triggering the parent
 * script's CLI arg parsing / katana-on-PATH checks (which call process.exit on import).
 */

export function normalize(rawUrl) {
    try {
        const u = new URL(rawUrl.trim());
        const collapsedPath = u.pathname.replace(/\/{2,}/g, "/");
        return `${u.origin}${collapsedPath}`;
    } catch {
        return null;
    }
}

export function normalizeSet(urls) {
    const out = new Set();
    for (const raw of urls) {
        const n = normalize(raw);
        if (n) out.add(n);
    }
    return out;
}
