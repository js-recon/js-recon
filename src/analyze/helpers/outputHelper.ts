import fs from "fs";
import path from "path";
import { printMsg, MSG } from "../../utility/printMsg.js";

export interface EngineOutput {
    ruleId: string;
    ruleName: string;
    ruleType: string;
    ruleDescription: string;
    ruleAuthor: string;
    ruleTech: ("next" | "vue" | "react" | "svelte" | "angular" | "all")[];
    severity: string;
    message: string;
    findingLocation: string;
    /** taintwire: what stands between source and sink (guard conditions and the checks inside them). */
    interceptors?: EngineInterceptor[];
    /** taintwire: how the value ends up in the sink (a same-origin path, a query, a selector prefix, a confining sink API). */
    confinements?: EngineInterceptor[];
    /** taintwire: the reasoning each mechanism gives about whether the finding is safe, kept apart. */
    explanation?: EngineExplanation;
}

/** Interceptors and confinements explain a finding separately; a side is present only when the finding has rows of it. */
export interface EngineExplanation {
    /** No interceptor policy yet, so `barrier` is always null. */
    interceptors?: { barrier: null; kinds: string[]; reason: string };
    /** `barrier`: a confinement makes the finding safe for its rule (what `--suppress-confined` leaves out). */
    confinements?: { barrier: boolean; kinds: string[]; reason: string };
}

/** One row of a taintwire sink's interceptors, with the code at its location. */
export interface EngineInterceptor {
    kind: string;
    text: string;
    location: string; // file:line:col
    code: string;
}

/**
 * Writes analysis findings to a JSON file.
 *
 * @param {string} outputFile - Path to the output file where findings will be written
 * @param {EngineOutput[]} findings - Array of analysis findings to write to the output file
 */
export const generateEngineOutput = (outputFile: string, findings: EngineOutput[]) => {
    printMsg(MSG.Header, "[i] Generating engine output...");
    fs.writeFileSync(outputFile, JSON.stringify(findings, null, 2));
    printMsg(MSG.Run, "[✓] Engine output generated successfully.");
};
