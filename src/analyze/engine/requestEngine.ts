import { Rule } from "../types/index.js";
import { OpenAPISpec } from "../../utility/openapiGenerator.js";
import { EngineOutput } from "../helpers/outputHelper.js";
import { printMsg, MSG } from "../../utility/printMsg.js";

/**
 * Request-based analysis engine for analyzing OpenAPI specifications against rules.
 *
 * This engine analyzes API endpoints, methods, headers, and URL patterns defined in
 * OpenAPI specifications to identify security issues, misconfigurations, or patterns
 * of interest. It supports multiple condition types including presence, absence, and equality checks.
 *
 * @param rule - The analysis rule containing request-based patterns to match
 * @param openapiData - OpenAPI specification containing API endpoint definitions
 * @returns Promise that resolves to an array of analysis findings
 */
const engine = async (rule: Rule, openapiData: OpenAPISpec): Promise<EngineOutput[]> => {
    let findings: EngineOutput[] = [];

    for (const path in openapiData.paths) {
        const methods = openapiData.paths[path];
        for (const method in methods) {
            const operation = methods[method];
            if (!operation) continue;

            let successfulSteps = 0;

            for (const step of rule.steps) {
                let stepSuccess = false;

                if (step.request.type === "url") {
                    const urlContainsName = path.includes(step.request.name);
                    if (step.request.condition === "contains") {
                        stepSuccess = urlContainsName;
                    } else if (step.request.condition === "absent") {
                        stepSuccess = !urlContainsName;
                    }
                } else if (step.request.type === "headers") {
                    const headers = operation.parameters?.filter((param) => param.in === "header");

                    if (step.request.condition === "contains") {
                        if (headers?.some((h) => h.name === step.request.name)) {
                            stepSuccess = true;
                        }
                    } else if (step.request.condition === "absent") {
                        if (!headers?.some((h) => h.name === step.request.name)) {
                            stepSuccess = true;
                        }
                    }
                } else if (step.request.type === "method") {
                    if (step.request.condition === "is") {
                        stepSuccess = method.toLowerCase() === step.request.name.toLowerCase();
                    } else if (step.request.condition === "is_not") {
                        stepSuccess = method.toLowerCase() !== step.request.name.toLowerCase();
                    }
                }

                if (stepSuccess) {
                    successfulSteps++;
                }
            }

            if (successfulSteps === rule.steps.length) {
                // get the severity of the rule
                const message = `[+] "${rule.name}" found in ${path} [${method.toUpperCase()}]`;
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
                    message: message,
                    findingLocation: `${path} [${method.toUpperCase()}]`,
                });
            }
        }
    }

    return findings;
};

export default engine;
