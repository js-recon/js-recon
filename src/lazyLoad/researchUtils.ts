export type TechniqueRecorder = (technique: string, urls: string[]) => void;

/**
 * Appends newly discovered URLs onto a technique's existing entry in a
 * research-mode efficiency map, without deduplicating across techniques —
 * the same URL may legitimately appear under multiple techniques since this
 * measures each technique's individual yield.
 */
export const accumulateTechnique = (map: Record<string, string[]>, technique: string, urls: string[]): void => {
    if (!urls || urls.length === 0) return;
    map[technique] = [...(map[technique] || []), ...urls];
};

export const createTechniqueRecorder = (map: Record<string, string[]>): TechniqueRecorder => {
    return (technique, urls) => accumulateTechnique(map, technique, urls);
};
