import { Chunks } from "../../utility/interfaces.js";
import { Rule } from "../types/index.js";

import parser from "@babel/parser";
import _traverse from "@babel/traverse";
import _generator from "@babel/generator";
const _traverseDefault = _traverse.default;
const generator = _generator.default;
import esquery from "esquery";
import { Node } from "@babel/types";
import { highlight } from "cli-highlight";
import { resolveFunctionIdentifier } from "../helpers/engineHelpers/resolveFunctionIdentifier.js";
import { findMemberExpressionAssignment } from "../helpers/engineHelpers/findMemberExpressionAssignment.js";
import { findDirectAssignment } from "../helpers/engineHelpers/findDirectAssignment.js";
import { computeTaint, sinkConsumesTaint, TaintInfo } from "../helpers/engineHelpers/taintFlow.js";
import { EngineOutput } from "../helpers/outputHelper.js";
import { printMsg, MSG } from "../../utility/printMsg.js";

/**
 * ESQuery-based AST analysis engine for detecting code patterns using custom rules.
 *
 * This engine parses JavaScript/TypeScript code into ASTs and uses ESQuery selectors
 * to find specific patterns defined in rules. It supports complex multi-step analysis
 * including function resolution and assignment checking.
 *
 * @param rule - The analysis rule containing steps and patterns to match
 * @param mappedJsonData - Collection of code chunks to analyze
 * @returns Promise that resolves to an array of analysis findings
 */
const esqueryEngine = async (rule: Rule, mappedJsonData: Chunks): Promise<EngineOutput[]> => {
    const findings: EngineOutput[] = [];

    for (const chunk of Object.values(mappedJsonData)) {
        // first of all, load the code in ast
        let ast;
        try {
            ast = parser.parse(chunk.code, {
                sourceType: "unambiguous",
                plugins: ["jsx", "typescript"],
                errorRecovery: true,
            });
        } catch {
            continue;
        }

        const matchList: { [key: string]: { node: Node; scope: Node; allNodes?: Node[] } } = {};
        const completedSteps: Set<string> = new Set();
        // Cache taint info per "source step name" so we don't recompute when several
        // sink steps share the same source step.
        const taintCache: { [sourceStep: string]: TaintInfo } = {};

        // iterate through the steps in the rule
        for (const step of rule.steps) {
            // honor `requires`: skip the step if any of its required steps did not complete
            if (step.requires && step.requires.length > 0) {
                const allRequiresMet = step.requires.every((r) => completedSteps.has(r));
                if (!allRequiresMet) {
                    continue;
                }
            }

            // if it is an esquery step, then only proceed
            if (step.esquery) {
                const selector = step.esquery.query;

                // determine the AST subtree to search. by default we search the whole chunk AST,
                // but `inScopeOf` lets a step look only inside a previous match's subtree —
                // useful for catching source/sink pairs in the same function rather than the same chunk.
                let searchRoot: Node = ast;
                if (step.esquery.inScopeOf) {
                    const scopeMatch = matchList[step.esquery.inScopeOf];
                    if (!scopeMatch) {
                        // dependency didn't match — this step cannot apply
                        continue;
                    }
                    searchRoot = scopeMatch.node;
                }

                // match the query against what is there in the user defined config file
                let matches: Node[] = esquery(searchRoot, selector);

                // Optional data-flow filter: only keep matches whose value-side actually
                // consumes a value tainted by the named source step's matches. This is
                // what distinguishes a real source→sink finding from accidental
                // source-and-sink-in-the-same-bundle co-occurrence.
                if (matches.length > 0 && step.esquery.taintFrom) {
                    const sourceStepName = step.esquery.taintFrom;
                    const sourceMatch = matchList[sourceStepName];
                    if (!sourceMatch) {
                        // No source matched — nothing can be tainted from it.
                        continue;
                    }
                    if (!taintCache[sourceStepName]) {
                        const sourceNodes = sourceMatch.allNodes || [sourceMatch.node];
                        taintCache[sourceStepName] = computeTaint(ast, sourceNodes);
                    }
                    const taint = taintCache[sourceStepName];
                    matches = matches.filter((m) => sinkConsumesTaint(ast, m, taint));
                }

                if (matches.length > 0) {
                    // store the first match as the "primary" node so later steps can reference it,
                    // and keep the full match list available for tooling that wants it.
                    matchList[step.name] = { node: matches[0], scope: ast, allNodes: matches };
                    completedSteps.add(step.name);
                }
            } else if (step.postMessageFuncResolve) {
                // since this is asking to resolve to a function declaration, we'll first get the node for it

                const selectedNode: Node = matchList[step.postMessageFuncResolve.name]?.node;

                if (selectedNode) {
                    // check if it a function declaration or a call expression
                    if (selectedNode.type === "CallExpression") {
                        if (
                            selectedNode.callee.type === "MemberExpression" &&
                            selectedNode.callee.property.type === "Identifier" &&
                            selectedNode.callee.property.name === "addEventListener" &&
                            selectedNode.arguments[0].type === "StringLiteral" &&
                            selectedNode.arguments[0].value === "message"
                        ) {
                            if (selectedNode.arguments.length === 2) {
                                // console.log(selectedNode.arguments[1].type);
                                // if the type is identifier
                                if (selectedNode.arguments[1].type === "Identifier") {
                                    // resolve where it is being assigned
                                    const functionIdentifier = selectedNode.arguments[1];
                                    const resolvedFunction = resolveFunctionIdentifier(functionIdentifier, ast);

                                    if (resolvedFunction) {
                                        matchList[step.name] = { node: resolvedFunction, scope: ast };
                                        completedSteps.add(step.name);
                                    }
                                } else if (
                                    selectedNode.arguments[1].type === "FunctionExpression" ||
                                    selectedNode.arguments[1].type === "ArrowFunctionExpression"
                                ) {
                                    const functionExpression = selectedNode.arguments[1];
                                    matchList[step.name] = { node: functionExpression, scope: ast };
                                    completedSteps.add(step.name);
                                }
                            }
                        }
                    }
                }
            } else if (step.regexMatch) {
                // Scan all StringLiteral/TemplateLiteral nodes in the chunk for values matching the regex
                // eslint-disable-next-line security/detect-non-literal-regexp -- pattern comes from a loaded rule YAML file — same trust model as the rest of the rule engine, not user/network input
                const pattern = new RegExp(step.regexMatch.pattern);
                const foundNodes: Node[] = [];
                _traverseDefault(ast, {
                    StringLiteral(nodePath: any) {
                        if (pattern.test(nodePath.node.value)) {
                            foundNodes.push(nodePath.node);
                        }
                    },
                    TemplateLiteral(nodePath: any) {
                        for (const quasi of nodePath.node.quasis) {
                            if (pattern.test(quasi.value.raw)) {
                                foundNodes.push(nodePath.node);
                                break;
                            }
                        }
                    },
                });
                if (foundNodes.length > 0) {
                    matchList[step.name] = { node: foundNodes[0], scope: ast, allNodes: foundNodes };
                    completedSteps.add(step.name);
                }
            } else if (step.checkAssignmentExist) {
                const selectedNode: Node = matchList[step.checkAssignmentExist.name]?.node;
                const toMatch = step.checkAssignmentExist.type;
                const memberExpression = step.checkAssignmentExist.memberExpression;

                if (selectedNode && memberExpression) {
                    const assignmentNode = findMemberExpressionAssignment(selectedNode, toMatch);

                    if (assignmentNode) {
                        matchList[step.name] = { node: assignmentNode, scope: ast };
                        completedSteps.add(step.name);
                    }
                } else if (selectedNode) {
                    const assignmentNode = findDirectAssignment(
                        selectedNode,
                        matchList[step.checkAssignmentExist.name].scope
                    );

                    if (assignmentNode) {
                        matchList[step.name] = { node: assignmentNode, scope: ast };
                        completedSteps.add(step.name);
                    }
                }
            }
        }

        // fire if every declared step has completed (matched) for this chunk
        if (completedSteps.size === rule.steps.length) {
            const message = `[+] "${rule.name}" found in chunk ${chunk.id}`;
            const lastMatch = Object.values(matchList)[Object.keys(matchList).length - 1];
            const nodesToReport =
                lastMatch.allNodes && lastMatch.allNodes.length > 1 ? lastMatch.allNodes : [lastMatch.node];

            for (const reportNode of nodesToReport) {
                const code = generator(reportNode).code;

                if (rule.severity === "info") {
                    printMsg(MSG.Header, message);
                } else if (rule.severity === "low") {
                    printMsg(MSG.Warn, message);
                } else if (rule.severity === "medium") {
                    printMsg(MSG.Info, message);
                } else if (rule.severity === "high") {
                    printMsg(MSG.Err, message);
                }

                printMsg(
                    MSG.Plain,
                    highlight(code, {
                        language: "javascript",
                        ignoreIllegals: true,
                        theme: undefined,
                    })
                );

                findings.push({
                    ruleId: rule.id,
                    ruleName: rule.name,
                    ruleType: rule.type,
                    ruleDescription: rule.description,
                    ruleAuthor: rule.author,
                    ruleTech: rule.tech,
                    severity: rule.severity,
                    message: message,
                    findingLocation: `// ${chunk.id}\n\n${code}`,
                });
            }
        }
    }

    return findings;
};

export default esqueryEngine;
