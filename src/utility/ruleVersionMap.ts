import { Rule } from "../analyze/types/index.js";

export interface VersionRequirement {
    min: string;
    max?: string;
}

/**
 * Maps a rule attribute (tech value, rule type, or step sub-feature) to the js-recon
 * version that introduced it, and, if it has since been retired, the version it was
 * removed in. Only attributes added after `js_recon_version` itself became mandatory
 * (1.3.1-alpha.3) need an entry here — anything from the original schema is implicitly
 * satisfied by any declared version.
 *
 * When `schemas.ts` or an engine gains/retires a capability, add/update the matching
 * entry here (see `src/analyze/CLAUDE.md`).
 */
export const RULE_VERSION_MAP: Record<string, VersionRequirement> = {
    "tech.vue": { min: "1.3.1-alpha.3" },
    "tech.all": { min: "1.3.1-alpha.3" },
    "tech.react": { min: "1.3.1-alpha.4" },
    "tech.svelte": { min: "1.3.1-alpha.4" },
    "tech.angular": { min: "1.4.1-alpha.4" },
    "type.cs-mast-s": { min: "1.4.1-alpha.5" },
    "step.esquery.inScopeOf": { min: "1.3.1-alpha.1" },
    "step.esquery.taintFrom": { min: "1.3.1-alpha.2" },
    "step.regexMatch": { min: "1.3.1-alpha.4" },
    "step.csMastS": { min: "1.4.1-alpha.5" },
};

const parseVersion = (version: string): [number, number, number] => {
    const clean = version.split("-")[0];
    const parts = clean.split(".").map(Number);
    return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
};

const compareVersions = (a: [number, number, number], b: [number, number, number]): number => {
    for (let i = 0; i < 3; i++) {
        if (a[i] !== b[i]) return a[i] - b[i];
    }
    return 0;
};

const isHigherMin = (a: string, b: string): boolean => compareVersions(parseVersion(a), parseVersion(b)) > 0;
const isLowerMax = (a: string, b: string): boolean => compareVersions(parseVersion(a), parseVersion(b)) < 0;

/**
 * Walks a parsed rule's tech list, type, and steps, looks up every attribute present
 * in RULE_VERSION_MAP, and folds the results into the strictest overall requirement:
 * the highest min version and (if any apply) the lowest max version.
 */
export const computeRequiredVersion = (rule: Rule): VersionRequirement => {
    const keys: string[] = [];

    for (const tech of rule.tech || []) {
        keys.push(`tech.${tech}`);
    }
    keys.push(`type.${rule.type}`);

    for (const step of rule.steps || []) {
        if (step.esquery?.inScopeOf !== undefined) keys.push("step.esquery.inScopeOf");
        if (step.esquery?.taintFrom !== undefined) keys.push("step.esquery.taintFrom");
        if (step.regexMatch) keys.push("step.regexMatch");
        if (step.csMastS) keys.push("step.csMastS");
    }

    let result: VersionRequirement = { min: "0.0.0" };

    for (const key of keys) {
        const requirement = RULE_VERSION_MAP[key];
        if (!requirement) continue;

        if (isHigherMin(requirement.min, result.min)) {
            result = { ...result, min: requirement.min };
        }
        if (requirement.max && (!result.max || isLowerMax(requirement.max, result.max))) {
            result = { ...result, max: requirement.max };
        }
    }

    return result;
};
