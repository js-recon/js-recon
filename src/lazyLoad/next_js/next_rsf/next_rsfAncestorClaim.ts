import type { AncestorSegment } from "./rsfShared.js";

/**
 * `next_rsfAncestorClaim`: claims ancestor segments as plain STATIC segments — the full
 * all-but-leaf chain, then the coarse first-segment-only claim. Returned least-specific last:
 * the `next_rsf` orchestrator stops a leaf-mode pass at the first success, so these run after
 * `next_rsfParamBruteforce`'s dynamic guesses (internal-docs#172).
 */
export const buildStaticAncestorAttempts = (pathSegments: string[]): AncestorSegment[][] => {
    if (pathSegments.length === 0) return [];
    const firstSegmentOnly: AncestorSegment[] = [pathSegments[0]];
    const allButLeaf = pathSegments.slice(0, -1);
    if (allButLeaf.length === 0 || allButLeaf.join("/") === pathSegments[0]) return [firstSegmentOnly];
    return [allButLeaf, firstSegmentOnly];
};
