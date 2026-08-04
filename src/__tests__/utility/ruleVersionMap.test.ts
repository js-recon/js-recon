import { describe, it, expect } from "vitest";
import { computeRequiredVersion } from "../../utility/ruleVersionMap.js";
import { Rule } from "../../analyze/types/index.js";

const baseRule = (overrides: Partial<Rule> = {}): Rule => ({
    id: "test-rule",
    name: "Test Rule",
    author: "test",
    description: "test",
    js_recon_version: ">=1.0.0",
    tech: ["next"],
    severity: "info",
    type: "ast",
    steps: [],
    ...overrides,
});

describe("computeRequiredVersion", () => {
    it("returns baseline 0.0.0 min when nothing in the rule hits the map", () => {
        const rule = baseRule({ tech: ["next"], type: "ast", steps: [{ name: "s", message: "m" }] });
        expect(computeRequiredVersion(rule)).toEqual({ min: "0.0.0" });
    });

    it("resolves a single tech-value requirement", () => {
        const rule = baseRule({ tech: ["vue"] });
        expect(computeRequiredVersion(rule)).toEqual({ min: "1.3.1-alpha.3" });
    });

    it("resolves a step-level requirement (regexMatch)", () => {
        const rule = baseRule({ steps: [{ name: "s", message: "m", regexMatch: { pattern: "x" } }] });
        expect(computeRequiredVersion(rule)).toEqual({ min: "1.3.1-alpha.4" });
    });

    it("resolves a rule type requirement (cs-mast-s)", () => {
        const rule = baseRule({
            type: "cs-mast-s",
            steps: [{ name: "s", message: "m", csMastS: { signature: "sig" } }],
        });
        expect(computeRequiredVersion(rule)).toEqual({ min: "1.4.1-alpha.5" });
    });

    it("picks the highest min across multiple hits", () => {
        const rule = baseRule({
            tech: ["svelte"],
            steps: [{ name: "s", message: "m", esquery: { type: "esquery", query: "*", taintFrom: "s0" } }],
        });
        // tech.svelte -> 1.3.1-alpha.4, step.esquery.taintFrom -> 1.3.1-alpha.2
        expect(computeRequiredVersion(rule)).toEqual({ min: "1.3.1-alpha.4" });
    });

    it("resolves esquery.inScopeOf independently from taintFrom", () => {
        const rule = baseRule({
            steps: [{ name: "s", message: "m", esquery: { type: "esquery", query: "*", inScopeOf: "s0" } }],
        });
        expect(computeRequiredVersion(rule)).toEqual({ min: "1.3.1-alpha.1" });
    });
});
