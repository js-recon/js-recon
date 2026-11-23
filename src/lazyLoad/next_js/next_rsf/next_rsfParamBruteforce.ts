import type { AncestorSegment } from "./rsfShared.js";

/**
 * `next_rsfParamBruteforce`: claims the last ancestor segment as a DYNAMIC route segment
 * (`[paramName, value, "d"]`), guessing the app's real param name — first from a fixed wordlist,
 * then from names harvested out of Flight bodies the failed attempts already returned. Run by the
 * `next_rsf` orchestrator (`./index.ts`), which owns request order and the harvest-bonus round.
 */

/**
 * Common dynamic route param names to guess when the last ancestor segment might be a
 * dynamic route (e.g. `[org]`, `[id]`) rather than a static one. Bounded to keep the
 * per-candidate request count small; a miss just falls through to the next guess. Worst
 * case per candidate URL: `(2 static attempts + this list's length)` guesses, each up to 2
 * key modes (legacy/strong) and up to 2 leaf modes (page/metadata-only) — i.e. roughly
 * `(2 + 20) * 2 * 2 = 88` requests before any RSC-body harvesting fallback (see
 * `extractParamNameCandidatesFromFlightBody`) kicks in, which only spends further requests
 * when this list's guesses all fail AND harvesting actually turns up a new name, capped by
 * `--rsc-param-bruteforce-limit`.
 */
export const COMMON_DYNAMIC_PARAM_NAMES = [
    "id",
    "slug",
    "org",
    "orgId",
    "organization",
    "tenant",
    "tenantId",
    "username",
    "userId",
    "user",
    "account",
    "accountId",
    "workspace",
    "workspaceId",
    "project",
    "projectId",
    "team",
    "teamId",
    "handle",
    "name",
    "key",
] as const;

/** Object-key-shaped identifiers that show up next to arbitrary string values in a Flight
 * payload without being the real dynamic-route param name — prop/DOM-attribute-like keys
 * that would otherwise slip past the value-anchored pattern below. `id` is included
 * deliberately: it's already in `COMMON_DYNAMIC_PARAM_NAMES`, so a harvested `"id":"<value>"`
 * hit would only ever duplicate an attempt already made. */
const PARAM_NAME_CANDIDATE_NOISE = new Set([
    "children",
    "className",
    "key",
    "ref",
    "type",
    "props",
    "default",
    "name",
    "title",
    "description",
    "href",
    "src",
    "id",
    "digest",
]);

/**
 * Extracts candidate dynamic-route param names from a Flight/RSC response body already
 * fetched during a failed forge attempt. Two anchored patterns, deliberately narrow to keep
 * the false-positive rate — and therefore the number of extra requests this feeds back into
 * `buildAncestorAttempts` — low:
 *
 * 1. **Value-anchored key extraction.** Flight serializes plain-object props passed to
 *    Client Component boundaries as ordinary `"key":"value"` pairs, even though the payload
 *    as a whole isn't valid JSON/JS. The crawl already knows the ancestor's literal *value*
 *    (`knownValue`, e.g. `"acme-corp"`) but not its *key* — so a key quoted immediately next
 *    to that known value is a strong signal for the real `[paramName]`.
 * 2. **Bracket-source pattern (dev-mode only).** Next.js dev error/stack payloads embed
 *    webpack module source paths verbatim, e.g.
 *    `webpack-internal:///(rsc)/./app/organizations/[org]/layout.tsx` — the bracketed
 *    segment there IS the real param name, no anchoring needed since `[name]` in a module
 *    path is unambiguous by construction.
 */
export const extractParamNameCandidatesFromFlightBody = (body: string, knownValue: string): string[] => {
    if (!knownValue) return [];
    const escapedValue = knownValue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const candidates = new Set<string>();

    const anchored = body.matchAll(new RegExp(`"([A-Za-z_$][A-Za-z0-9_$]{0,40})"\\s*:\\s*"${escapedValue}"`, "g"));
    for (const m of anchored) candidates.add(m[1]);

    const bracketed = body.matchAll(/\/\[([A-Za-z_$][A-Za-z0-9_$]{0,40})\]/g);
    for (const m of bracketed) candidates.add(m[1]);

    return [...candidates].filter((c) => !PARAM_NAME_CANDIDATE_NOISE.has(c) && c.length <= 24);
};

/**
 * The literal value of the ancestor segment a dynamic-route guess targets (the last segment
 * before the leaf), or `undefined` when the path has no ancestor chain distinct from its first
 * segment — in that case only the coarse first-segment claim (`next_rsfAncestorClaim`) applies.
 */
export const lastAncestorValue = (pathSegments: string[]): string | undefined => {
    const allButLeaf = pathSegments.slice(0, -1);
    if (allButLeaf.length === 0 || allButLeaf.join("/") === pathSegments[0]) return undefined;
    return allButLeaf[allButLeaf.length - 1];
};

/** One ancestor claim per candidate name: every segment but the leaf, with the last one claimed
 * as `{ paramName, value }` — the only shape that can match a real dynamic-route ancestor. */
export const buildDynamicGuessAttempts = (
    pathSegments: string[],
    paramNameCandidates: readonly string[] = COMMON_DYNAMIC_PARAM_NAMES
): AncestorSegment[][] => {
    const value = lastAncestorValue(pathSegments);
    if (value === undefined) return [];
    const withoutLastAncestor = pathSegments.slice(0, -2);
    return paramNameCandidates.map((paramName) => [...withoutLastAncestor, { paramName, value }]);
};
