import { cs_mast_init, parseSignature, ParseError } from "@shriyanss/cs-mast";
import type { CsMastConfig, ScatCategory, AdapterNode } from "@shriyanss/cs-mast";
import { Chunks } from "../../utility/interfaces.js";
import { Rule } from "../types/index.js";
import { EngineOutput } from "../helpers/outputHelper.js";
import { printMsg, MSG } from "../../utility/printMsg.js";

/**
 * Walk all AdapterNode descendants post-order and check if any node's
 * computedHash equals the target hex hash. The _signatureMap built by
 * cs_mast_init only stores leaf-level node signatures; to match the
 * compound (internal-node) signatures produced by the experiment scripts
 * (buildSignatureFromConfig on a specific subtree), we must walk the tree
 * and compare computedHash directly.
 */
function treeContainsHash(node: AdapterNode, targetHashHex: string): boolean {
    if (node.computedHash === targetHashHex) return true;
    for (const child of node.children ?? []) {
        if (treeContainsHash(child, targetHashHex)) return true;
    }
    return false;
}

/**
 * CS-MAST-S analysis engine. Checks whether a CS-MAST-S signature (PHC string)
 * exists anywhere in a chunk's AST. Suitable for regression detection: once a
 * vulnerability is confirmed via the AST engine, its signature can be embedded
 * in a cs-mast-s rule to track whether the same code reappears in future builds.
 *
 * Each step must contain a `csMastS.signature` (PHC string). The scat config is
 * derived automatically from the signature — no separate config field is needed.
 * All steps must match in the same chunk for a finding to fire.
 *
 * @param rule - The cs-mast-s rule with signature steps
 * @param mappedJsonData - Code chunks from mapped.json
 * @returns Array of findings
 */
const csMastSEngine = async (rule: Rule, mappedJsonData: Chunks): Promise<EngineOutput[]> => {
    const findings: EngineOutput[] = [];

    for (const chunk of Object.values(mappedJsonData)) {
        // Cache cs_mast trees by config fingerprint to avoid redundant parses when
        // multiple steps share the same scat config.
        const treeCache = new Map<string, ReturnType<typeof cs_mast_init>>();

        const completedSteps = new Set<string>();

        for (const step of rule.steps) {
            // Honor requires: skip if any prerequisite step didn't match.
            if (step.requires && step.requires.length > 0) {
                const allMet = step.requires.every((r) => completedSteps.has(r));
                if (!allMet) continue;
            }

            if (!step.csMastS) continue;

            const { signature } = step.csMastS;
            const parsed = parseSignature(signature);
            if (!parsed) {
                printMsg(
                    MSG.Warn,
                    `[!] cs-mast-s step "${step.name}" in rule "${rule.id}" has an invalid signature — skipping`
                );
                continue;
            }

            const config: CsMastConfig = {
                hash: parsed.hash as "sha256",
                lang: parsed.lang,
                prsr: parsed.prsr,
                scat: parsed.scat as ScatCategory[],
                sinc: parsed.sinc as ScatCategory[],
                sourceType: "unambiguous",
            };

            // Build a stable cache key from the config fields that affect the hash tree.
            const configKey = `${config.hash}:${config.lang}:${config.prsr}:${config.scat.join("_")}:${config.sinc.join("_")}`;

            let tree: ReturnType<typeof cs_mast_init>;
            if (treeCache.has(configKey)) {
                tree = treeCache.get(configKey)!;
            } else {
                try {
                    tree = cs_mast_init(chunk.code, config);
                    treeCache.set(configKey, tree);
                } catch (e) {
                    if (e instanceof ParseError) {
                        // Chunk is unparseable — skip silently (mirrors astEngine behavior).
                        break;
                    }
                    throw e;
                }
            }

            if (treeContainsHash(tree.root, parsed.hashHex)) {
                completedSteps.add(step.name);
            }
        }

        // Fire only if every step in the rule completed (matched).
        if (completedSteps.size === rule.steps.length) {
            const matchedSigs = rule.steps.filter((s) => s.csMastS).map((s) => s.csMastS!.signature);

            const message = `[+] "${rule.name}" found in chunk ${chunk.id}`;

            if (rule.severity === "info") {
                printMsg(MSG.Header, message);
            } else if (rule.severity === "low") {
                printMsg(MSG.Warn, message);
            } else if (rule.severity === "medium") {
                printMsg(MSG.Info, message);
            } else if (rule.severity === "high") {
                printMsg(MSG.Err, message);
            }

            findings.push({
                ruleId: rule.id,
                ruleName: rule.name,
                ruleType: rule.type,
                ruleDescription: rule.description,
                ruleAuthor: rule.author,
                ruleTech: rule.tech,
                severity: rule.severity,
                message,
                findingLocation: `// chunk: ${chunk.id}\n// CS-MAST-S signature: ${matchedSigs.join(", ")}`,
            });
        }
    }

    return findings;
};

export default csMastSEngine;
