import fs from "fs";
import path from "path";
import validateRules from "./helpers/validate.js";
import checkOrApplyRuleVersions from "./helpers/determineCompatibleVersion.js";
import { Rule } from "./types/index.js";
import engine from "./engine/index.js";
import yaml from "yaml";
import { Chunks } from "../utility/interfaces.js";
import { OpenAPISpec } from "../utility/openapiGenerator.js";
import initRules from "./helpers/initRules.js";
import { EngineOutput, generateEngineOutput } from "./helpers/outputHelper.js";
import { printMsg, MSG } from "../utility/printMsg.js";
import { getAnalyzeTaintwire } from "../utility/globals.js";
import { listFilesRecursive } from "../utility/listFiles.js";

const availableTechs = {
    next: "Next.js",
    vue: "Vue.js",
    react: "React",
    svelte: "Svelte/Astro",
    angular: "Angular",
};

/**
 * Analyzes JavaScript code using custom rules and generates findings.
 *
 * This function loads and validates rules, processes mapped JSON data or OpenAPI specs,
 * and runs analysis engines to identify potential security issues or code patterns.
 *
 * @param rulesPath - Path to rules file or directory containing YAML rule files
 * @param mappedJson - Path to the mapped JSON file containing code analysis data
 * @param tech - Technology stack identifier (currently supports "next" for Next.js)
 * @param list - Whether to list available technologies instead of running analysis
 * @param openapi - Path to OpenAPI specification file for API analysis
 * @param validate - Whether to only validate rules without running analysis
 * @param outputFile - Output file name for analysis results
 * @param disableRulesVersionCheck - Skip the GitHub rules version check and use cached rules as-is
 * @param determineCompatibleVersion - Whether to report the compatible js_recon_version/js_recon_max_version for each rule
 * @param applyCompatibleVersions - Whether to rewrite rule files with the compatible versions
 * @returns Promise that resolves when analysis is complete
 */
const analyze = async (
    rulesPath: string,
    mappedJson: string,
    tech: "next" | "vue" | "react" | "svelte" | "angular",
    list: boolean,
    openapi: string,
    validate: boolean,
    outputFile: string,
    disableRulesVersionCheck: boolean = false,
    determineCompatibleVersion: boolean = false,
    applyCompatibleVersions: boolean = false
) => {
    printMsg(MSG.Header, `[i] Loading analyze module...`);

    await initRules(disableRulesVersionCheck);

    // check if `-r` flag is there. If not, default to `~/.js-recon/rules`
    if (!rulesPath || rulesPath === "") {
        rulesPath = path.join(process.env.HOME, "/.js-recon/rules");
    }

    // check if `rules` exists
    if (!fs.existsSync(rulesPath)) {
        printMsg(MSG.Err, `[!] Rules ${rulesPath} does not exist`);
        return;
    }

    // now that the rule thing exist, check if it is a direcotory or a file
    let ruleFiles: string[] = [];

    if (fs.lstatSync(rulesPath).isDirectory()) {
        ruleFiles = listFilesRecursive(rulesPath, [".yml", ".yaml"]);
    } else {
        ruleFiles = [rulesPath];
    }

    // now, validate all those files
    const { allValid: allValidated, compatibleRuleFiles } = await validateRules(ruleFiles);

    if (!allValidated) {
        printMsg(MSG.Err, "[!] Some rules are invalid");
        process.exit(20);
    }

    if (determineCompatibleVersion || applyCompatibleVersions) {
        const allCorrect = await checkOrApplyRuleVersions(ruleFiles, applyCompatibleVersions);
        if (!allCorrect && !applyCompatibleVersions) {
            process.exit(20);
        }
        return;
    }

    if (validate) {
        printMsg(MSG.Run, "[✓] All rules are valid");
        return;
    }

    // check if the list flag is passed. If so, list the techs and return
    if (list) {
        printMsg(MSG.Run, "[i] List of available technologies");
        for (const [key, value] of Object.entries(availableTechs)) {
            printMsg(MSG.Run, `- ${key}: ${value}`);
        }
        return;
    }

    // check if a valid tech is passed
    if (!availableTechs[tech]) {
        printMsg(MSG.Err, `[!] Invalid technology ${tech}.`);
        printMsg(MSG.Warn, "[i] Run with -l/--list to see available technologies");
        return;
    }

    // check if either mappedJson or either openapi is passed
    if (!mappedJson && !openapi) {
        printMsg(MSG.Err, "[!] Either mappedJson or openapi must be passed");
        return;
    }

    // check if the mappedJson and openapi exists if they are not undefined
    if (mappedJson && !fs.existsSync(mappedJson)) {
        printMsg(MSG.Err, `[!] Mapped JSON ${mappedJson} does not exist`);
        return;
    }
    if (openapi && !fs.existsSync(openapi)) {
        printMsg(MSG.Err, `[!] OpenAPI spec ${openapi} does not exist`);
        return;
    }

    // load the mapped json and openapi in memory
    let mappedJsonData: Chunks | undefined;
    let openapiData: OpenAPISpec | undefined;
    if (mappedJson) {
        mappedJsonData = JSON.parse(fs.readFileSync(mappedJson, "utf8"));
        printMsg(MSG.Run, `[✓] Mapped JSON loaded successfully`);
    }
    if (openapi) {
        openapiData = JSON.parse(fs.readFileSync(openapi, "utf8"));
        printMsg(MSG.Run, `[✓] OpenAPI spec loaded successfully`);
    }

    // iterate over the ruleFiles
    const ruleFindings: EngineOutput[] = [];
    const taintwireRules: Rule[] = [];
    for (const ruleFile of compatibleRuleFiles) {
        // load the rule
        const rule: Rule = yaml.parse(fs.readFileSync(ruleFile, "utf8"));

        // taintwire rules share one set of graphs, so they run together below
        if (rule.type === "taintwire") {
            if (rule.tech.includes(tech) || rule.tech.includes("all")) taintwireRules.push(rule);
            continue;
        }

        // run the rule
        const engineFindings: EngineOutput[] = await engine(rule, mappedJsonData, openapiData, tech);

        // add findings to the global findings
        // one at a time: spreading a large array into push() exceeds the argument limit
        if (engineFindings) for (const finding of engineFindings) ruleFindings.push(finding);
    }

    let failedTaintwireRules: string[] = [];
    if (taintwireRules.length > 0 && mappedJsonData) {
        if (getAnalyzeTaintwire()) {
            // dynamic import: the native graph database loads only when taintwire rules run
            const { default: taintwireEngine } = await import("./engine/taintwireEngine.js");
            const { findings, failedRules } = await taintwireEngine(taintwireRules, mappedJsonData);
            for (const finding of findings) ruleFindings.push(finding);
            failedTaintwireRules = failedRules;
        } else {
            printMsg(
                MSG.Info,
                `[i] Skipped ${taintwireRules.length} taintwire rule(s); pass --analyze-taintwire to run them`
            );
        }
    }

    // generate the engine output
    generateEngineOutput(outputFile, ruleFindings);

    // The findings of the other rules are written; the exit code tells a caller this analysis is incomplete.
    // exitCode, not exit(): run keeps going to the report step and exits with it.
    if (failedTaintwireRules.length > 0) {
        printMsg(
            MSG.Err,
            `[!] ${failedTaintwireRules.length} taintwire rule(s) failed: ${failedTaintwireRules.join(", ")}`
        );
        process.exitCode = 41;
    }
};

export default analyze;
