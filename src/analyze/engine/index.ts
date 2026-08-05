import { Rule } from "../types/index.js";
import { Chunks } from "../../utility/interfaces.js";
import { OpenAPISpec } from "../../utility/openapiGenerator.js";
import requestEngine from "./requestEngine.js";
import astEngine from "./astEngine.js";
import csMastSEngine from "./csMastSEngine.js";
import { EngineOutput } from "../helpers/outputHelper.js";

/**
 * Main analysis engine that routes rules to appropriate sub-engines based on rule type.
 *
 * This function serves as the central dispatcher for analysis rules, determining whether
 * to use the AST engine for code analysis or the request engine for API analysis.
 * It validates technology compatibility before executing the appropriate engine.
 *
 * @param rule - The analysis rule containing patterns and conditions to match
 * @param mappedJsonData - Code chunks data for AST-based analysis (optional)
 * @param openapiData - OpenAPI specification data for request-based analysis (optional)
 * @param tech - Technology stack identifier or "all" for universal rules
 * @returns Promise that resolves to an array of analysis findings, or undefined if no data available
 */
export const engine = async (
    rule: Rule,
    mappedJsonData: Chunks | undefined,
    openapiData: OpenAPISpec | undefined,
    tech: "next" | "vue" | "react" | "svelte" | "angular" | "all"
): Promise<EngineOutput[] | undefined> => {
    // first of all check what is rule type, and then check if the data for that is available or is undefined

    const findings: EngineOutput[] = [];

    if (rule.type === "request") {
        if (!openapiData) {
            return;
        }

        let techValid = true;
        for (const t of rule.tech) {
            if (!rule.tech.includes(tech)) {
                techValid = false;
            }
        }

        if (techValid || tech === "all" || rule.tech.includes("all")) {
            findings.push(...(await requestEngine(rule, openapiData)));
        }
    } else if (rule.type === "ast") {
        if (!mappedJsonData) {
            return;
        }

        let techValid = true;
        for (const t of rule.tech) {
            if (!rule.tech.includes(tech)) {
                techValid = false;
            }
        }

        if (techValid || tech === "all" || rule.tech.includes("all")) {
            findings.push(...(await astEngine(rule, mappedJsonData)));
        }
    } else if (rule.type === "cs-mast-s") {
        if (!mappedJsonData) {
            return;
        }

        let techValid = true;
        for (const t of rule.tech) {
            if (!rule.tech.includes(tech)) {
                techValid = false;
            }
        }

        if (techValid || tech === "all" || rule.tech.includes("all")) {
            findings.push(...(await csMastSEngine(rule, mappedJsonData)));
        }
    }

    return findings;
};

export default engine;
