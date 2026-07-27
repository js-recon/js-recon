import fs from "fs";
import yaml from "yaml";
import { Rule } from "../types/index.js";
import { computeRequiredVersion } from "../../utility/ruleVersionMap.js";
import { printMsg, MSG } from "../../utility/printMsg.js";

/**
 * For each rule file, computes the js_recon_version/js_recon_max_version actually
 * required by the features it uses (via RULE_VERSION_MAP) and compares it against
 * what's declared. Prints a mismatch for every non-compliant file (checks all files
 * before returning, per the CLI's exit-code contract) and, when `apply` is true,
 * rewrites only the mismatched version field(s) via a targeted line replacement on
 * the raw file text — not a full yaml parse+stringify round-trip, which would
 * reformat the entire file (indentation, line wrapping) and produce a much larger
 * diff than the version-field change actually warrants.
 *
 * @returns true only if every rule file was already correct
 */
const checkOrApplyRuleVersions = async (ruleFiles: string[], apply: boolean): Promise<boolean> => {
    printMsg(MSG.Header, `[i] ${apply ? "Applying" : "Determining"} compatible rule versions...`);
    let allCorrect = true;

    for (const ruleFile of ruleFiles) {
        const raw = fs.readFileSync(ruleFile, "utf8");
        const doc = yaml.parseDocument(raw);
        const rule = doc.toJS() as Rule;

        const required = computeRequiredVersion(rule);
        const expectedMin = required.min !== "0.0.0" ? `>=${required.min}` : undefined;
        const expectedMax = required.max ? `<${required.max}` : undefined;

        const minMismatch = expectedMin !== undefined && rule.js_recon_version !== expectedMin;
        const maxMismatch = expectedMax !== undefined && rule.js_recon_max_version !== expectedMax;

        if (!minMismatch && !maxMismatch) {
            continue;
        }

        allCorrect = false;

        if (!apply) {
            printMsg(MSG.Err, `[!] ${ruleFile}: incompatible declared version`);
            if (minMismatch) {
                printMsg(MSG.Err, `  - js_recon_version is "${rule.js_recon_version}", expected "${expectedMin}"`);
            }
            if (maxMismatch) {
                printMsg(
                    MSG.Err,
                    `  - js_recon_max_version is "${rule.js_recon_max_version}", expected "${expectedMax}"`
                );
            }
            continue;
        }

        let updated = raw;
        if (minMismatch && expectedMin !== undefined) {
            updated = updated.replace(/^js_recon_version:.*$/m, `js_recon_version: "${expectedMin}"`);
        }
        if (maxMismatch && expectedMax !== undefined) {
            if (/^js_recon_max_version:.*$/m.test(updated)) {
                updated = updated.replace(/^js_recon_max_version:.*$/m, `js_recon_max_version: "${expectedMax}"`);
            } else {
                updated = updated.replace(
                    /^js_recon_version:.*$/m,
                    (line) => `${line}\njs_recon_max_version: "${expectedMax}"`
                );
            }
        }
        fs.writeFileSync(ruleFile, updated);
        printMsg(MSG.Run, `[✓] Updated ${ruleFile}`);
    }

    return allCorrect;
};

export default checkOrApplyRuleVersions;
