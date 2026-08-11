import { Node } from "@babel/types";
import parser from "@babel/parser";
import { Scope } from "@babel/traverse";
import _traverse from "@babel/traverse";
import { Chunks } from "../../utility/interfaces.js";
const traverse = (_traverse.default ?? _traverse) as typeof _traverse.default;

/**
 * Builds a dotted identifier path from a chain of MemberExpression nodes
 * rooted at an Identifier. Returns null when the chain contains computed
 * properties, non-Identifier nodes, or anything we can't render as `a.b.c`.
 */
export const memberChainToString = (node: any): string | null => {
    if (!node) return null;
    if (node.type === "Identifier") return node.name;
    if (node.type === "MemberExpression" && !node.computed && node.property?.type === "Identifier") {
        const obj = memberChainToString(node.object);
        if (!obj) return null;
        return `${obj}.${node.property.name}`;
    }
    return null;
};

/**
 * Produces a short human-readable label for a spread argument we couldn't fully
 * resolve. Identifiers keep their name; member chains collapse into `a.b.c`;
 * call expressions show their callee name with `()`. Anything else falls back
 * to the AST node type so the placeholder still signals *something* was there.
 */
const describeSpreadArg = (arg: any): string => {
    if (!arg) return "unknown";
    if (arg.type === "Identifier") return arg.name;
    if (arg.type === "MemberExpression") {
        const parts: string[] = [];
        let walker: any = arg;
        while (
            walker &&
            walker.type === "MemberExpression" &&
            !walker.computed &&
            walker.property?.type === "Identifier"
        ) {
            parts.unshift(walker.property.name);
            walker = walker.object;
        }
        if (walker && walker.type === "Identifier") parts.unshift(walker.name);
        if (parts.length > 0) return parts.join(".");
        return "member";
    }
    if (arg.type === "CallExpression") {
        if (arg.callee?.type === "Identifier") return `${arg.callee.name}()`;
        if (arg.callee?.type === "MemberExpression" && arg.callee.property?.type === "Identifier") {
            return `${arg.callee.property.name}()`;
        }
        return "call()";
    }
    return arg.type;
};

/**
 * Resolves a variable in a chunk by finding its declaration/assignment.
 *
 * @param varName - The name of the variable to resolve
 * @param chunkCode - The source code of the chunk
 * @param depth - Current recursion depth to prevent infinite loops
 * @returns The resolved value or a placeholder if unresolved
 */
/**
 * Returns true if the given path is nested inside a loop statement.
 * Used to skip loop-internal variable assignments that would shadow the
 * top-level declaration we are interested in.
 */
const isInsideLoop = (p: any): boolean => {
    let current = p.parentPath;
    while (current) {
        if (
            current.isForStatement() ||
            current.isForInStatement() ||
            current.isForOfStatement() ||
            current.isWhileStatement() ||
            current.isDoWhileStatement()
        ) {
            return true;
        }
        // Don't cross function boundaries
        if (current.isFunction()) break;
        current = current.parentPath;
    }
    return false;
};

export const resolveVariableInChunk = (varName: string, chunkCode: string, depth: number = 0): any => {
    if (depth > 5) {
        return `[max recursion depth for ${varName}]`;
    }

    try {
        const ast = parser.parse(chunkCode, {
            sourceType: "module",
            plugins: ["jsx", "typescript"],
            errorRecovery: true,
        });

        let resolvedValue: any = null;

        traverse(ast, {
            // Find variable declarations: let/const/var varName = ...
            VariableDeclarator(path) {
                // Skip declarations that are inside loops — they are loop counters or
                // temporaries and would shadow the top-level variable we care about.
                if (isInsideLoop(path)) return;

                if (path.node.id.type === "Identifier" && path.node.id.name === varName && path.node.init) {
                    const init = path.node.init;

                    if (init.type === "StringLiteral") {
                        resolvedValue = init.value;
                        path.stop();
                    } else if (init.type === "NumericLiteral") {
                        resolvedValue = String(init.value);
                        path.stop();
                    } else if (init.type === "TemplateLiteral") {
                        // Handle template literals
                        let result = "";
                        for (let i = 0; i < init.quasis.length; i++) {
                            result += init.quasis[i].value.raw;
                            if (i < init.expressions.length) {
                                const expr = init.expressions[i];
                                if (expr.type === "Identifier") {
                                    // Recursively resolve nested variables
                                    const nestedValue = resolveVariableInChunk(expr.name, chunkCode, depth + 1);
                                    result += nestedValue;
                                } else {
                                    result += `[${expr.type}]`;
                                }
                            }
                        }
                        resolvedValue = result;
                        path.stop();
                    } else if (init.type === "Identifier") {
                        // Recursively resolve if it references another variable
                        resolvedValue = resolveVariableInChunk(init.name, chunkCode, depth + 1);
                        path.stop();
                    } else if (
                        init.type === "CallExpression" &&
                        init.callee.type === "MemberExpression" &&
                        init.callee.property.type === "Identifier" &&
                        init.callee.property.name === "concat"
                    ) {
                        // Handle concat chains
                        const parts: string[] = [];
                        let currentCall: any = init;

                        while (
                            currentCall.type === "CallExpression" &&
                            currentCall.callee.type === "MemberExpression" &&
                            currentCall.callee.property.type === "Identifier" &&
                            currentCall.callee.property.name === "concat"
                        ) {
                            for (const arg of currentCall.arguments) {
                                if (arg.type === "StringLiteral") {
                                    parts.unshift(arg.value);
                                } else if (arg.type === "Identifier") {
                                    const argValue = resolveVariableInChunk(arg.name, chunkCode, depth + 1);
                                    parts.unshift(argValue);
                                } else {
                                    parts.unshift(`[${arg.type}]`);
                                }
                            }
                            currentCall = currentCall.callee.object;
                        }

                        if (currentCall.type === "StringLiteral") {
                            parts.unshift(currentCall.value);
                        } else if (currentCall.type === "Identifier") {
                            const baseValue = resolveVariableInChunk(currentCall.name, chunkCode, depth + 1);
                            parts.unshift(baseValue);
                        }

                        resolvedValue = parts.join("");
                        path.stop();
                    }
                }
            },
            // Find assignments: varName = ...
            AssignmentExpression(path) {
                // Skip assignments inside loops for the same reason as above
                if (isInsideLoop(path)) return;

                if (path.node.left.type === "Identifier" && path.node.left.name === varName) {
                    const right = path.node.right;

                    if (right.type === "StringLiteral") {
                        resolvedValue = right.value;
                        path.stop();
                    } else if (right.type === "NumericLiteral") {
                        resolvedValue = String(right.value);
                        path.stop();
                    } else if (right.type === "Identifier") {
                        resolvedValue = resolveVariableInChunk(right.name, chunkCode, depth + 1);
                        path.stop();
                    }
                }
            },
        });

        return resolvedValue || `[unresolved: ${varName}]`;
    } catch (e) {
        return `[error resolving ${varName}: ${e.message}]`;
    }
};

/**
 * Wraps resolveVariableInChunk and only returns the result when it looks like a
 * URL component (contains "/" or "://"). Identifiers inside function bodies may
 * coincidentally match module-scope declarations with the same name — gating on
 * URL shape prevents substituting non-URL values into URL templates.
 */
export const resolveChunkVarAsUrlPart = (name: string, code: string): string | null => {
    const val = resolveVariableInChunk(name, code);
    if (!val || String(val).startsWith("[")) return null;
    const s = String(val);
    return s.includes("/") || s.includes("://") ? s : null;
};

/**
 * Resolves a member expression like "obj.property" in a chunk.
 *
 * @param objectName - The name of the object variable
 * @param propertyName - The name of the property to access
 * @param chunkCode - The source code of the chunk
 * @param chunks - All available chunks for cross-chunk resolution
 * @param thirdArgName - The name of the third parameter (webpack require function)
 * @param depth - Current recursion depth to prevent infinite loops
 * @returns The resolved value or a placeholder if unresolved
 */
export const resolveMemberExpressionInChunk = (
    objectName: string,
    propertyName: string,
    chunkCode: string,
    chunks?: Chunks,
    thirdArgName?: string,
    depth: number = 0
): any => {
    if (depth > 10) {
        return `[max recursion depth for ${objectName}.${propertyName}]`;
    }

    try {
        const ast = parser.parse(chunkCode, {
            sourceType: "module",
            plugins: ["jsx", "typescript"],
            errorRecovery: true,
        });

        let resolvedValue: any = null;

        traverse(ast, {
            VariableDeclarator(path) {
                if (path.node.id.type === "Identifier" && path.node.id.name === objectName && path.node.init) {
                    const init = path.node.init;

                    // Check if this is a webpack chunk import: u = r(3269)
                    if (
                        init.type === "CallExpression" &&
                        init.callee.type === "Identifier" &&
                        thirdArgName &&
                        init.callee.name === thirdArgName &&
                        init.arguments.length > 0 &&
                        init.arguments[0].type === "NumericLiteral" &&
                        chunks
                    ) {
                        // This is a webpack chunk import, use resolveWebpackChunkImport with the property name
                        const chunkImportValue = resolveWebpackChunkImport(
                            objectName,
                            chunkCode,
                            chunks,
                            thirdArgName,
                            [propertyName]
                        );

                        if (
                            chunkImportValue &&
                            typeof chunkImportValue === "string" &&
                            !chunkImportValue.startsWith("[unresolved") &&
                            !chunkImportValue.startsWith("[error")
                        ) {
                            resolvedValue = chunkImportValue;
                            path.stop();
                            return;
                        }
                    }

                    // Handle object expressions: let obj = { prop: "value" }
                    if (init.type === "ObjectExpression") {
                        for (const prop of init.properties) {
                            if (
                                prop.type === "ObjectProperty" &&
                                prop.key.type === "Identifier" &&
                                prop.key.name === propertyName
                            ) {
                                const value = prop.value;

                                if (value.type === "StringLiteral") {
                                    resolvedValue = value.value;
                                    path.stop();
                                    return;
                                } else if (value.type === "NumericLiteral") {
                                    resolvedValue = String(value.value);
                                    path.stop();
                                    return;
                                } else if (value.type === "Identifier") {
                                    resolvedValue = resolveVariableInChunk(value.name, chunkCode, depth + 1);
                                    path.stop();
                                    return;
                                } else if (value.type === "LogicalExpression") {
                                    // Handle: baseUrl: c.env.UMAMI_API_ENDPOINT || "https://..."
                                    const right = value.right;
                                    if (right.type === "StringLiteral") {
                                        resolvedValue = right.value;
                                        path.stop();
                                        return;
                                    }
                                } else if (value.type === "TemplateLiteral") {
                                    let result = "";
                                    for (let i = 0; i < value.quasis.length; i++) {
                                        result += value.quasis[i].value.raw;
                                        if (i < value.expressions.length) {
                                            const expr = value.expressions[i];
                                            if (expr.type === "Identifier") {
                                                const nestedValue = resolveVariableInChunk(
                                                    expr.name,
                                                    chunkCode,
                                                    depth + 1
                                                );
                                                result += nestedValue;
                                            } else {
                                                result += `[${expr.type}]`;
                                            }
                                        }
                                    }
                                    resolvedValue = result;
                                    path.stop();
                                    return;
                                } else if (
                                    value.type === "CallExpression" &&
                                    value.callee.type === "MemberExpression" &&
                                    value.callee.property.type === "Identifier" &&
                                    value.callee.property.name === "concat"
                                ) {
                                    // Handle concat chains in property values
                                    const parts: string[] = [];
                                    let currentCall: any = value;

                                    while (
                                        currentCall.type === "CallExpression" &&
                                        currentCall.callee.type === "MemberExpression" &&
                                        currentCall.callee.property.type === "Identifier" &&
                                        currentCall.callee.property.name === "concat"
                                    ) {
                                        for (const arg of currentCall.arguments) {
                                            if (arg.type === "StringLiteral") {
                                                parts.unshift(arg.value);
                                            } else if (arg.type === "Identifier") {
                                                const argValue = resolveVariableInChunk(arg.name, chunkCode, depth + 1);
                                                parts.unshift(argValue);
                                            } else {
                                                parts.unshift(`[${arg.type}]`);
                                            }
                                        }
                                        currentCall = currentCall.callee.object;
                                    }

                                    if (currentCall.type === "StringLiteral") {
                                        parts.unshift(currentCall.value);
                                    } else if (currentCall.type === "Identifier") {
                                        const baseValue = resolveVariableInChunk(
                                            currentCall.name,
                                            chunkCode,
                                            depth + 1
                                        );
                                        parts.unshift(baseValue);
                                    }

                                    resolvedValue = parts.join("");
                                    path.stop();
                                    return;
                                }
                            }
                        }
                    }
                    // Handle if object is assigned to another variable
                    else if (init.type === "Identifier") {
                        resolvedValue = resolveMemberExpressionInChunk(
                            init.name,
                            propertyName,
                            chunkCode,
                            chunks,
                            thirdArgName,
                            depth + 1
                        );
                        path.stop();
                    }
                }
            },
        });

        return resolvedValue || `[unresolved: ${objectName}.${propertyName}]`;
    } catch (e) {
        return `[error resolving ${objectName}.${propertyName}: ${e.message}]`;
    }
};

/**
 * Substitutes [var X] placeholders in a string with their resolved values.
 *
 * @param str - The string containing [var X] placeholders
 * @param chunkCode - The source code of the chunk to resolve variables from
 * @param chunks - All available chunks for cross-chunk resolution
 * @param thirdArgName - The name of the third parameter (webpack require function)
 * @returns The string with variables substituted
 */
export const substituteVariablesInString = (
    str: string,
    chunkCode: string,
    chunks?: Chunks,
    thirdArgName?: string
): string => {
    if (typeof str !== "string") return str;

    let result = str;

    // Match [MemberExpression -> propertyName] patterns
    const memberPattern = /\[MemberExpression -> ([^\]]+)\]/g;
    let memberMatch;

    while ((memberMatch = memberPattern.exec(str)) !== null) {
        const propertyName = memberMatch[1];

        // Try to find the object that contains this property
        // We need to look at the context where this placeholder came from
        // For now, we'll search for common patterns in the chunk
        try {
            const ast = parser.parse(chunkCode, {
                sourceType: "module",
                plugins: ["jsx", "typescript"],
                errorRecovery: true,
            });

            let foundValue: string | null = null;

            traverse(ast, {
                MemberExpression(path) {
                    if (
                        path.node.property.type === "Identifier" &&
                        path.node.property.name === propertyName &&
                        path.node.object.type === "Identifier"
                    ) {
                        const objectName = path.node.object.name;
                        const resolvedValue = resolveMemberExpressionInChunk(
                            objectName,
                            propertyName,
                            chunkCode,
                            chunks,
                            thirdArgName
                        );

                        if (
                            typeof resolvedValue === "string" &&
                            !resolvedValue.startsWith("[unresolved:") &&
                            !resolvedValue.startsWith("[error") &&
                            !resolvedValue.startsWith("[max recursion")
                        ) {
                            foundValue = resolvedValue;
                            path.stop();
                        }
                    }
                },
            });

            if (foundValue) {
                result = result.replace(`[MemberExpression -> ${propertyName}]`, foundValue);
            }
        } catch (e) {
            // Skip if parsing fails
        }
    }

    // Match [var varName] patterns
    const varPattern = /\[var ([^\]]+)\]/g;
    let match;

    while ((match = varPattern.exec(str)) !== null) {
        const varName = match[1];
        const resolvedValue = resolveVariableInChunk(varName, chunkCode);

        // Only substitute if we got a clean value (not an error/unresolved placeholder).
        // Also reject values that contain placeholder-style brackets (they are not fully
        // resolved), pure numbers (likely loop counters, not URL segments), very long
        // strings (likely resolved to code, not a URL component), or strings containing
        // ANSI escape sequences (leaked from logging utilities in the bundle).
        if (
            typeof resolvedValue === "string" &&
            !resolvedValue.startsWith("[unresolved:") &&
            !resolvedValue.startsWith("[error") &&
            !resolvedValue.startsWith("[max recursion") &&
            !resolvedValue.includes("[") &&
            !/^\d+$/.test(resolvedValue) &&
            !/^\d+:\d+$/.test(resolvedValue) &&
            !resolvedValue.includes("\x1b") &&
            resolvedValue.length <= 500
        ) {
            result = result.replace(`[var ${varName}]`, resolvedValue);
        }
    }

    return result;
};

/**
 * Resolves webpack chunk imports by tracing through chunk definitions.
 *
 * This function handles patterns like:
 * - `i = l(17917)` where `l` is the third arg and `17917` is a chunk ID
 * - Finds exports in the target chunk (e.g., `l: function() { return n; }`)
 * - Recursively follows references to resolve the final object
 * - Supports nested member expressions like `i.l.FLOW.postFlowCompleteStatus`
 *
 * @param identifierName - The name of the identifier to resolve (e.g., 'i')
 * @param chunkCode - The source code of the current chunk
 * @param chunks - All available chunks for cross-chunk resolution
 * @param thirdArgName - The name of the third parameter (webpack require function)
 * @param memberPath - Array of property names to traverse (e.g., ['l', 'FLOW', 'getTaxonomies'])
 * @returns The resolved value or a descriptive placeholder
 */
export const resolveWebpackChunkImport = (
    identifierName: string,
    chunkCode: string,
    chunks: Chunks,
    thirdArgName: string,
    memberPath: string[] = []
): any => {
    try {
        // Parse the current chunk to find the identifier definition
        const ast = parser.parse(chunkCode, {
            sourceType: "unambiguous",
            plugins: ["jsx", "typescript"],
            errorRecovery: true,
        });

        let targetChunkId: string | null = null;

        // Find pattern: identifierName = thirdArgName(chunkNumber)
        traverse(ast, {
            AssignmentExpression(path) {
                const left = path.node.left;
                const right = path.node.right;

                // Check if left side matches our identifier
                if (left.type === "Identifier" && left.name === identifierName) {
                    // console.log(`[DEBUG] Found assignment to ${identifierName}, right side type: ${right.type}`);
                    if (right.type === "CallExpression") {
                        // console.log(`[DEBUG] CallExpression callee type: ${right.callee.type}, callee name: ${right.callee.type === "Identifier" ? right.callee.name : "N/A"}`);
                    }
                    // Check if right side is thirdArgName(number)
                    if (
                        right.type === "CallExpression" &&
                        right.callee.type === "Identifier" &&
                        right.callee.name === thirdArgName &&
                        right.arguments.length > 0
                    ) {
                        const arg = right.arguments[0];
                        if (arg.type === "NumericLiteral") {
                            targetChunkId = String(arg.value);
                        } else if (arg.type === "StringLiteral") {
                            targetChunkId = arg.value;
                        }
                        path.stop();
                    }
                }
            },
            VariableDeclarator(path) {
                const id = path.node.id;
                const init = path.node.init;

                if (id.type === "Identifier" && id.name === identifierName && init) {
                    // console.log(`[DEBUG] Found variable declarator for ${identifierName}, init type: ${init.type}`);
                    if (init.type === "CallExpression") {
                        // console.log(`[DEBUG] CallExpression callee type: ${init.callee.type}, callee name: ${init.callee.type === "Identifier" ? init.callee.name : "N/A"}`);
                    }
                    if (
                        init.type === "CallExpression" &&
                        init.callee.type === "Identifier" &&
                        init.callee.name === thirdArgName &&
                        init.arguments.length > 0
                    ) {
                        const arg = init.arguments[0];
                        if (arg.type === "NumericLiteral") {
                            targetChunkId = String(arg.value);
                        } else if (arg.type === "StringLiteral") {
                            targetChunkId = arg.value;
                        }
                        path.stop();
                    }
                }
            },
        });

        if (!targetChunkId) {
            // console.log(`[DEBUG] Could not find chunk import for ${identifierName} using third arg ${thirdArgName}`);
            return `[unresolved: could not find chunk import for ${identifierName}]`;
        }

        // console.log(`[DEBUG] Resolved ${identifierName} to chunk ${targetChunkId}, looking for path: ${memberPath.join('.')}`);

        // Find the target chunk
        const targetChunk = chunks[targetChunkId];
        if (!targetChunk) {
            return `[unresolved: chunk ${targetChunkId} not found]`;
        }

        // If no member path, return a placeholder
        if (memberPath.length === 0) {
            return `[webpack_import: chunk_${targetChunkId}]`;
        }

        // Parse the target chunk
        let targetAst;
        try {
            targetAst = parser.parse(targetChunk.code, {
                sourceType: "unambiguous",
                plugins: ["jsx", "typescript"],
                errorRecovery: true,
            });
        } catch {
            return `[webpack_import: chunk_${targetChunkId}]`;
        }

        // Find the export for the first property in memberPath
        const firstProperty = memberPath[0];
        let resolvedValue: any = null;

        // Helper to resolve a value recursively in the target chunk
        const resolveInChunk = (varName: string, currentAst: Node, depth: number = 0): any => {
            if (depth > 10) {
                return `[max_depth_exceeded]`;
            }

            let result: any = null;

            traverse(currentAst, {
                // Look for: propertyName: function() { return someVar; }
                ObjectProperty(path) {
                    if (result) return; // Already found

                    const key = path.node.key;
                    const value = path.node.value;

                    // Check if key matches what we're looking for
                    const keyName =
                        key.type === "Identifier" ? key.name : key.type === "StringLiteral" ? key.value : null;

                    if (keyName === varName) {
                        // Check if it's a function that returns something
                        if (value.type === "FunctionExpression" || value.type === "ArrowFunctionExpression") {
                            const body = value.body;
                            if (body.type === "BlockStatement" && body.body.length > 0) {
                                const lastStatement = body.body[body.body.length - 1];
                                if (lastStatement.type === "ReturnStatement" && lastStatement.argument) {
                                    if (lastStatement.argument.type === "Identifier") {
                                        // Recursively resolve the returned identifier
                                        result = resolveInChunk(lastStatement.argument.name, currentAst, depth + 1);
                                    } else if (lastStatement.argument.type === "ObjectExpression") {
                                        // Directly an object
                                        result = lastStatement.argument;
                                    } else if (lastStatement.argument.type === "CallExpression") {
                                        result = lastStatement.argument;
                                    }
                                }
                            } else if (body.type === "ObjectExpression") {
                                // Arrow function directly returning an object
                                result = body;
                            } else if (body.type === "Identifier") {
                                // Arrow function returning an identifier
                                result = resolveInChunk(body.name, currentAst, depth + 1);
                            }
                        } else if (value.type === "ObjectExpression") {
                            result = value;
                        } else if (value.type === "Identifier") {
                            result = resolveInChunk(value.name, currentAst, depth + 1);
                        }
                        path.stop();
                    }
                },
                // Look for: let varName = { ... } or const varName = { ... }
                VariableDeclarator(path) {
                    if (result) return;

                    const id = path.node.id;
                    const init = path.node.init;

                    if (id.type === "Identifier" && id.name === varName && init) {
                        if (init.type === "ObjectExpression") {
                            result = init;
                        } else if (init.type === "Identifier") {
                            result = resolveInChunk(init.name, currentAst, depth + 1);
                        } else if (init.type === "CallExpression") {
                            result = init;
                        }
                        path.stop();
                    }
                },
            });

            return result;
        };

        // Start resolving from the first property
        const initialResolved = resolveInChunk(firstProperty, targetAst);

        if (!initialResolved) {
            // console.log(`[DEBUG] Property ${firstProperty} not found in chunk ${targetChunkId}`);
            return `[unresolved: property ${firstProperty} not found in chunk ${targetChunkId}]`;
        }

        // console.log(`[DEBUG] Found property ${firstProperty} in chunk ${targetChunkId}`);

        // Convert AST node to JavaScript object
        const convertAstToValue = (node: Node, remainingPath: string[] = []): any => {
            if (!node) return null;

            // Unwrap Object.freeze({...}) — single-arg wrapper that returns its first arg.
            if (
                node.type === "CallExpression" &&
                (node as any).callee?.type === "MemberExpression" &&
                (node as any).callee.property?.type === "Identifier" &&
                (node as any).callee.property.name === "freeze" &&
                (node as any).arguments?.length > 0
            ) {
                return convertAstToValue((node as any).arguments[0], remainingPath);
            }

            // Unwrap Object.assign(target, ...sources) by merging each arg's properties
            // so downstream remainingPath lookups can resolve keys contributed by sources.
            if (
                node.type === "CallExpression" &&
                (node as any).callee?.type === "MemberExpression" &&
                (node as any).callee.property?.type === "Identifier" &&
                (node as any).callee.property.name === "assign" &&
                (node as any).arguments?.length > 0
            ) {
                const merged: { [key: string]: any } = {};
                for (const arg of (node as any).arguments) {
                    const value = convertAstToValue(arg, []);
                    if (value && typeof value === "object" && !Array.isArray(value)) {
                        Object.assign(merged, value);
                    }
                }
                if (remainingPath.length === 0) return merged;
                const [next, ...rest] = remainingPath;
                if (next in merged) {
                    const v = merged[next];
                    if (rest.length === 0) return v;
                    if (v && typeof v === "object") {
                        let cur: any = v;
                        for (const k of rest) {
                            if (cur && typeof cur === "object" && k in cur) cur = cur[k];
                            else return null;
                        }
                        return cur;
                    }
                    return null;
                }
                return null;
            }

            if (node.type === "ObjectExpression") {
                const obj: { [key: string]: any } = {};
                for (const prop of node.properties) {
                    if (prop.type === "ObjectProperty") {
                        let key: string | null = null;
                        if (prop.key.type === "Identifier") {
                            key = prop.key.name;
                        } else if (prop.key.type === "StringLiteral") {
                            key = prop.key.value;
                        }

                        if (key) {
                            const value = prop.value;
                            if (value.type === "ArrowFunctionExpression" || value.type === "FunctionExpression") {
                                // Try to extract the return value from arrow/regular functions
                                let returnValue: any = null;

                                if (value.type === "ArrowFunctionExpression") {
                                    // Arrow function: could be expression body or block body
                                    if (value.body.type !== "BlockStatement") {
                                        // Expression body - directly use it
                                        returnValue = value.body;
                                    } else if (value.body.body.length > 0) {
                                        // Block body - look for return statement
                                        const returnStmt: any = value.body.body.find(
                                            (stmt: any) => stmt.type === "ReturnStatement"
                                        );
                                        if (
                                            returnStmt &&
                                            returnStmt.type === "ReturnStatement" &&
                                            returnStmt.argument
                                        ) {
                                            returnValue = returnStmt.argument;
                                        }
                                    }
                                } else if (value.type === "FunctionExpression" && value.body.body.length > 0) {
                                    // Regular function - look for return statement
                                    const returnStmt: any = value.body.body.find(
                                        (stmt: any) => stmt.type === "ReturnStatement"
                                    );
                                    if (returnStmt && returnStmt.type === "ReturnStatement" && returnStmt.argument) {
                                        returnValue = returnStmt.argument;
                                    }
                                }

                                // Process the return value
                                if (returnValue) {
                                    if (returnValue.type === "StringLiteral") {
                                        obj[key] = returnValue.value;
                                    } else if (returnValue.type === "TemplateLiteral") {
                                        // Handle template literals in function returns
                                        const parts: string[] = [];
                                        for (let i = 0; i < returnValue.quasis.length; i++) {
                                            parts.push(returnValue.quasis[i].value.raw);
                                            if (i < returnValue.expressions.length) {
                                                const expr = returnValue.expressions[i];
                                                if (expr.type === "Identifier") {
                                                    parts.push(
                                                        resolveChunkVarAsUrlPart(expr.name, targetChunk.code) ??
                                                            `[var ${expr.name}]`
                                                    );
                                                } else {
                                                    parts.push(`[${expr.type}]`);
                                                }
                                            }
                                        }

                                        // Reorganize if base URL found
                                        let baseUrlIndex = -1;
                                        for (let i = 0; i < parts.length; i++) {
                                            if (
                                                typeof parts[i] === "string" &&
                                                (parts[i].startsWith("http://") || parts[i].startsWith("https://"))
                                            ) {
                                                baseUrlIndex = i;
                                                break;
                                            }
                                        }

                                        if (baseUrlIndex > 0) {
                                            const beforeUrl = parts.slice(0, baseUrlIndex);
                                            const baseUrl = parts[baseUrlIndex];
                                            const afterUrl = parts.slice(baseUrlIndex + 1);
                                            // Normalize slashes to avoid double slashes
                                            const result = (baseUrl + beforeUrl.join("") + afterUrl.join("")).replace(
                                                /([^:]\/)\/+/g,
                                                "$1"
                                            );
                                            obj[key] = result;
                                        } else {
                                            obj[key] = parts.join("");
                                        }
                                    } else if (
                                        returnValue.type === "CallExpression" &&
                                        returnValue.callee.type === "MemberExpression" &&
                                        returnValue.callee.property.type === "Identifier" &&
                                        returnValue.callee.property.name === "concat"
                                    ) {
                                        // Handle concat chains in function returns
                                        let currentCall: any = returnValue;
                                        const parts: string[] = [];

                                        while (
                                            currentCall.type === "CallExpression" &&
                                            currentCall.callee.type === "MemberExpression" &&
                                            currentCall.callee.property.type === "Identifier" &&
                                            currentCall.callee.property.name === "concat"
                                        ) {
                                            for (const arg of currentCall.arguments) {
                                                if (arg.type === "StringLiteral") {
                                                    parts.unshift(arg.value);
                                                } else if (arg.type === "Identifier") {
                                                    parts.unshift(
                                                        resolveChunkVarAsUrlPart(arg.name, targetChunk.code) ??
                                                            `[var ${arg.name}]`
                                                    );
                                                } else {
                                                    parts.unshift(`[${arg.type}]`);
                                                }
                                            }
                                            currentCall = currentCall.callee.object;
                                        }

                                        if (currentCall && currentCall.type === "StringLiteral") {
                                            parts.unshift(currentCall.value);
                                        } else if (currentCall && currentCall.type === "Identifier") {
                                            parts.unshift(
                                                resolveChunkVarAsUrlPart(currentCall.name, targetChunk.code) ??
                                                    `[var ${currentCall.name}]`
                                            );
                                        }

                                        // Reorganize parts if a base URL is found in the middle
                                        let baseUrlIndex = -1;
                                        for (let i = 0; i < parts.length; i++) {
                                            if (
                                                typeof parts[i] === "string" &&
                                                (parts[i].startsWith("http://") || parts[i].startsWith("https://"))
                                            ) {
                                                baseUrlIndex = i;
                                                break;
                                            }
                                        }

                                        if (baseUrlIndex > 0) {
                                            // Move base URL to the front and append path parts
                                            const beforeUrl = parts.slice(0, baseUrlIndex);
                                            const baseUrl = parts[baseUrlIndex];
                                            const afterUrl = parts.slice(baseUrlIndex + 1);

                                            // Reconstruct: baseUrl + beforeUrl + afterUrl and normalize slashes
                                            const result = (baseUrl + beforeUrl.join("") + afterUrl.join("")).replace(
                                                /([^:]\/)\/+/g,
                                                "$1"
                                            );
                                            obj[key] = result;
                                        } else {
                                            obj[key] = parts.join("");
                                        }
                                    } else {
                                        obj[key] = `[function -> ${returnValue.type}]`;
                                    }
                                } else {
                                    obj[key] = `[function]`;
                                }
                            } else if (value.type === "StringLiteral") {
                                obj[key] = value.value;
                            } else if (value.type === "NumericLiteral") {
                                obj[key] = value.value;
                            } else if (value.type === "ObjectExpression") {
                                obj[key] = convertAstToValue(value, []);
                            } else if (value.type === "TemplateLiteral") {
                                // Handle template literals
                                const parts: string[] = [];
                                for (let i = 0; i < value.quasis.length; i++) {
                                    parts.push(value.quasis[i].value.raw);
                                    if (i < value.expressions.length) {
                                        const expr = value.expressions[i];
                                        if (expr.type === "Identifier") {
                                            parts.push(
                                                resolveChunkVarAsUrlPart(expr.name, targetChunk.code) ??
                                                    `[var ${expr.name}]`
                                            );
                                        } else {
                                            parts.push(`[${expr.type}]`);
                                        }
                                    }
                                }

                                // Reorganize if base URL found
                                let baseUrlIndex = -1;
                                for (let i = 0; i < parts.length; i++) {
                                    if (
                                        typeof parts[i] === "string" &&
                                        (parts[i].startsWith("http://") || parts[i].startsWith("https://"))
                                    ) {
                                        baseUrlIndex = i;
                                        break;
                                    }
                                }

                                if (baseUrlIndex > 0) {
                                    const beforeUrl = parts.slice(0, baseUrlIndex);
                                    const baseUrl = parts[baseUrlIndex];
                                    const afterUrl = parts.slice(baseUrlIndex + 1);
                                    const result = (baseUrl + beforeUrl.join("") + afterUrl.join("")).replace(
                                        /([^:]\/)\/+/g,
                                        "$1"
                                    );
                                    obj[key] = result;
                                } else {
                                    obj[key] = parts.join("");
                                }
                            } else if (value.type === "CallExpression") {
                                // Handle concat patterns
                                if (
                                    value.callee.type === "MemberExpression" &&
                                    value.callee.property.type === "Identifier" &&
                                    value.callee.property.name === "concat"
                                ) {
                                    // Try to resolve concat chain
                                    let currentCall: any = value;
                                    const parts: string[] = [];

                                    // Walk back through the concat chain
                                    while (
                                        currentCall.type === "CallExpression" &&
                                        currentCall.callee.type === "MemberExpression" &&
                                        currentCall.callee.property.type === "Identifier" &&
                                        currentCall.callee.property.name === "concat"
                                    ) {
                                        // Get arguments
                                        for (const arg of currentCall.arguments) {
                                            if (arg.type === "StringLiteral") {
                                                parts.unshift(arg.value);
                                            } else if (arg.type === "Identifier") {
                                                parts.unshift(
                                                    resolveChunkVarAsUrlPart(arg.name, targetChunk.code) ??
                                                        `[var ${arg.name}]`
                                                );
                                            } else {
                                                parts.unshift(`[${arg.type}]`);
                                            }
                                        }
                                        currentCall = currentCall.callee.object;
                                    }

                                    // Get the base string
                                    if (currentCall && currentCall.type === "StringLiteral") {
                                        parts.unshift(currentCall.value);
                                    } else if (currentCall && currentCall.type === "Identifier") {
                                        parts.unshift(
                                            resolveChunkVarAsUrlPart(currentCall.name, targetChunk.code) ??
                                                `[var ${currentCall.name}]`
                                        );
                                    }

                                    // Reorganize parts if a base URL is found in the middle
                                    let baseUrlIndex = -1;
                                    for (let i = 0; i < parts.length; i++) {
                                        if (
                                            typeof parts[i] === "string" &&
                                            (parts[i].startsWith("http://") || parts[i].startsWith("https://"))
                                        ) {
                                            baseUrlIndex = i;
                                            break;
                                        }
                                    }

                                    if (baseUrlIndex > 0) {
                                        const beforeUrl = parts.slice(0, baseUrlIndex);
                                        const baseUrl = parts[baseUrlIndex];
                                        const afterUrl = parts.slice(baseUrlIndex + 1);
                                        const result = (baseUrl + beforeUrl.join("") + afterUrl.join("")).replace(
                                            /([^:]\/)\/+/g,
                                            "$1"
                                        );
                                        obj[key] = result;
                                    } else {
                                        obj[key] = parts.join("");
                                    }
                                } else {
                                    obj[key] = `[CallExpression]`;
                                }
                            } else {
                                obj[key] = `[${value.type}]`;
                            }
                        }
                    }
                }

                // If we have remaining path, traverse it
                if (remainingPath.length > 0) {
                    let current = obj;
                    for (const prop of remainingPath) {
                        if (current && typeof current === "object" && prop in current) {
                            current = current[prop];
                        } else {
                            return `[unresolved: property ${prop} not found]`;
                        }
                    }
                    return current;
                }

                return obj;
            }

            return `[unsupported AST node: ${node.type}]`;
        };

        // Convert and resolve the remaining member path
        const remainingPath = memberPath.slice(1);
        resolvedValue = convertAstToValue(initialResolved, remainingPath);

        // console.log(`[DEBUG] Final resolved value for ${identifierName}.${memberPath.join('.')}: ${typeof resolvedValue === 'object' ? JSON.stringify(resolvedValue) : resolvedValue}`);
        return resolvedValue;
    } catch (e) {
        return `[error resolving webpack import: ${e.message}]`;
    }
};

/**
 * Resolves AST node values to their actual runtime values for fetch and axios calls.
 *
 * This function performs deep resolution of JavaScript AST nodes, handling:
 * - String literals, template literals, and concatenation
 * - Object expressions and member access
 * - Variable bindings and identifier resolution
 * - Call expressions including JSON.stringify
 * - Logical and conditional expressions
 * - Binary expressions and arithmetic operations
 * - Webpack chunk imports (for axios with chunks context)
 *
 * @param initialNode - The AST node to resolve
 * @param scope - The Babel scope for variable resolution
 * @param nodeCode - The source code string for the node
 * @param callType - Whether this is for 'fetch' or 'axios' call analysis
 * @param chunkCode - Optional: The source code of the current chunk (for webpack resolution)
 * @param chunks - Optional: All available chunks (for webpack resolution)
 * @param thirdArgName - Optional: The webpack require function name (for webpack resolution)
 * @returns The resolved value or a descriptive placeholder string
 */
export const resolveNodeValue = (
    initialNode: Node,
    scope: Scope,
    nodeCode: string,
    callType: "fetch" | "axios" | "new",
    chunkCode?: string,
    chunks?: Chunks,
    thirdArgName?: string
): any => {
    let currentNode: Node | null = initialNode;
    const visited = new Set<Node>();

    try {
        while (currentNode) {
            if (visited.has(currentNode)) {
                return "[cyclic reference]";
            }
            visited.add(currentNode);

            if (!currentNode) return null;

            // fetch specific ops
            if (callType === "fetch") {
                // check if it is a JSON.stringify call
                if (currentNode.type === "CallExpression" && currentNode.callee.type === "MemberExpression") {
                    if (
                        currentNode.callee.property.type === "Identifier" &&
                        currentNode.callee.property.name === "stringify"
                    ) {
                        // if so, then first get the args for it
                        const args = currentNode.arguments;

                        // see if the first arg is an object
                        if (args.length > 0 && args[0].type === "ObjectExpression") {
                            // if it is an object, then convert stringify it
                            const obj: { [key: string]: any } = {};
                            for (const prop of args[0].properties) {
                                if (prop.type === "ObjectProperty" && prop.key.type === "Identifier") {
                                    const key = prop.key.name;
                                    if (prop.value.type === "Identifier") {
                                        // Try to resolve via scope; fall back to [param:name] for params
                                        const valBinding = scope.getBinding(prop.value.name);
                                        if (valBinding && (valBinding.path.node as any).init) {
                                            const resolved = resolveNodeValue(
                                                prop.value,
                                                scope,
                                                "",
                                                callType,
                                                chunkCode,
                                                chunks,
                                                thirdArgName
                                            );
                                            obj[key] = resolved;
                                        } else if (valBinding && valBinding.kind === "param") {
                                            obj[key] = `[param:${prop.value.name}]`;
                                        } else {
                                            obj[key] = prop.value.name;
                                        }
                                    } else if (
                                        prop.value.type === "CallExpression" &&
                                        prop.value.callee.type === "MemberExpression" &&
                                        prop.value.callee.property.type === "Identifier" &&
                                        prop.value.callee.property.name === "stringify"
                                    ) {
                                        // Nested JSON.stringify(expr) — resolve expr so we show what's being serialized.
                                        const innerArgs = prop.value.arguments;
                                        if (innerArgs.length > 0) {
                                            obj[key] =
                                                resolveNodeValue(
                                                    innerArgs[0] as Node,
                                                    scope,
                                                    "",
                                                    callType,
                                                    chunkCode,
                                                    chunks,
                                                    thirdArgName
                                                ) ?? "[call to object...]";
                                        } else {
                                            obj[key] = "[call to object...]";
                                        }
                                    } else {
                                        obj[key] =
                                            resolveNodeValue(
                                                prop.value,
                                                scope,
                                                "",
                                                callType,
                                                chunkCode,
                                                chunks,
                                                thirdArgName
                                            ) ?? `[${prop.value.type}]`;
                                    }
                                } else if (prop.type === "SpreadElement") {
                                    // Resolve the spread argument; if it's a known object, merge its
                                    // keys. Otherwise surface the spread as a sentinel key so the
                                    // downstream body shape advertises that there are unresolvable
                                    // additional fields, rather than silently shrinking the body.
                                    const spreadResolved = resolveNodeValue(
                                        prop.argument,
                                        scope,
                                        "",
                                        callType,
                                        chunkCode,
                                        chunks,
                                        thirdArgName
                                    );
                                    if (
                                        spreadResolved &&
                                        typeof spreadResolved === "object" &&
                                        !Array.isArray(spreadResolved)
                                    ) {
                                        for (const [sk, sv] of Object.entries(spreadResolved)) {
                                            if (!(sk in obj)) obj[sk] = sv;
                                        }
                                    } else {
                                        const argName = describeSpreadArg(prop.argument);
                                        obj[`...${argName}`] = "<spread>";
                                    }
                                }
                            }
                            return obj;
                        } else if (args.length > 0) {
                            // Argument isn't a literal object — try resolving it (handles Identifier,
                            // ConditionalExpression, etc.) so we can surface the actual body shape.
                            const resolved = resolveNodeValue(
                                args[0] as Node,
                                scope,
                                nodeCode,
                                callType,
                                chunkCode,
                                chunks,
                                thirdArgName
                            );
                            if (
                                resolved !== null &&
                                resolved !== undefined &&
                                resolved !== "[call_stack_exceeded_use_better_machine]"
                            ) {
                                return resolved;
                            }
                        }
                    }
                }
            }

            switch (currentNode.type) {
                case "StringLiteral":
                case "NumericLiteral":
                case "BooleanLiteral":
                    return currentNode.value;
                case "NullLiteral":
                    return null;
                case "TemplateLiteral": {
                    let result = "";
                    for (let i = 0; i < currentNode.quasis.length; i++) {
                        result += currentNode.quasis[i].value.raw;
                        if (i < currentNode.expressions.length) {
                            const resolved = resolveNodeValue(
                                currentNode.expressions[i],
                                scope,
                                nodeCode,
                                callType,
                                chunkCode,
                                chunks,
                                thirdArgName
                            );
                            if (resolved === "[call_stack_exceeded_use_better_machine]") {
                                return resolved;
                            }
                            result += resolved;
                        }
                    }
                    return result;
                }
                case "Identifier": {
                    const binding = scope.getBinding(currentNode.name);
                    if (binding && (binding.path.node as any).init) {
                        const initNode = (binding.path.node as any).init;
                        // Update nodeCode to the actual source of the init so that concat
                        // patterns (e.g. "".concat(x, "/path")) are re-parsed correctly
                        if (
                            chunkCode &&
                            typeof (initNode as any).start === "number" &&
                            typeof (initNode as any).end === "number"
                        ) {
                            nodeCode = chunkCode
                                .slice((initNode as any).start, (initNode as any).end)
                                .replace(/\n\s*/g, "");
                        }
                        currentNode = initNode;
                        continue;
                    }
                    if (binding && binding.kind === "param") {
                        return `[param:${currentNode.name}]`;
                    }
                    return `[unresolved: ${currentNode.name}]`;
                }
                case "ObjectExpression": {
                    const obj = {};
                    for (const prop of currentNode.properties) {
                        if (prop.type === "ObjectProperty") {
                            let key;
                            if (prop.computed) {
                                const resolved = resolveNodeValue(
                                    prop.key,
                                    scope,
                                    nodeCode,
                                    callType,
                                    chunkCode,
                                    chunks,
                                    thirdArgName
                                );
                                if (resolved === "[call_stack_exceeded_use_better_machine]") {
                                    return resolved;
                                }
                                key = resolved;
                            } else if (prop.key.type === "Identifier") {
                                key = prop.key.name;
                            } else if (prop.key.type === "StringLiteral") {
                                key = prop.key.value;
                            }
                            const value = resolveNodeValue(
                                prop.value,
                                scope,
                                nodeCode,
                                callType,
                                chunkCode,
                                chunks,
                                thirdArgName
                            );
                            if (value === "[call_stack_exceeded_use_better_machine]") {
                                return value;
                            }
                            obj[key] = value;
                        } else if (prop.type === "SpreadElement") {
                            const resolved = resolveNodeValue(
                                prop.argument,
                                scope,
                                nodeCode,
                                callType,
                                chunkCode,
                                chunks,
                                thirdArgName
                            );
                            if (resolved === "[call_stack_exceeded_use_better_machine]") {
                                return resolved;
                            }
                            const spreadObj = resolved;
                            if (typeof spreadObj === "object" && spreadObj !== null) {
                                Object.assign(obj, spreadObj);
                            } else {
                                // Couldn't resolve to a concrete object — keep the spread visible
                                // in the output so callers know fields are missing.
                                const argName = describeSpreadArg(prop.argument);
                                obj[`...${argName}`] = "<spread>";
                            }
                        }
                    }
                    return obj;
                }
                case "OptionalMemberExpression":
                case "MemberExpression": {
                    // Handle deeply-nested webpack chunk imports by flattening the chain:
                    //   s.h.NEXT_OKTA_VALIDATE_USER  ->  resolveWebpackChunkImport("s", ..., ["h", "NEXT_OKTA_VALIDATE_USER"])
                    if (chunkCode && chunks && thirdArgName && !currentNode.computed) {
                        const chain: string[] = [];
                        let walker: any = currentNode;
                        let rootIdent: string | null = null;
                        while (walker) {
                            if (
                                walker.type === "MemberExpression" &&
                                !walker.computed &&
                                walker.property.type === "Identifier"
                            ) {
                                chain.unshift(walker.property.name);
                                walker = walker.object;
                            } else if (walker.type === "Identifier") {
                                rootIdent = walker.name;
                                break;
                            } else {
                                break;
                            }
                        }
                        if (rootIdent && chain.length > 0) {
                            try {
                                const webpackResult = resolveWebpackChunkImport(
                                    rootIdent,
                                    chunkCode,
                                    chunks,
                                    thirdArgName,
                                    chain
                                );
                                if (
                                    webpackResult !== null &&
                                    webpackResult !== undefined &&
                                    typeof webpackResult === "string" &&
                                    !webpackResult.startsWith("[unresolved") &&
                                    !webpackResult.startsWith("[error") &&
                                    !webpackResult.startsWith("[unsupported") &&
                                    !webpackResult.startsWith("[max_depth")
                                ) {
                                    return webpackResult;
                                }
                            } catch (e) {
                                // fall through
                            }
                        }
                    }

                    const object = resolveNodeValue(
                        currentNode.object,
                        scope,
                        nodeCode,
                        callType,
                        chunkCode,
                        chunks,
                        thirdArgName
                    );
                    if (object === "[call_stack_exceeded_use_better_machine]") {
                        return object;
                    }
                    if (typeof object === "object" && object !== null) {
                        let propertyName;
                        if (currentNode.computed) {
                            const resolved = resolveNodeValue(
                                currentNode.property,
                                scope,
                                nodeCode,
                                callType,
                                chunkCode,
                                chunks,
                                thirdArgName
                            );
                            if (resolved === "[call_stack_exceeded_use_better_machine]") {
                                return resolved;
                            }
                            propertyName = resolved;
                        } else if (currentNode.property.type === "Identifier") {
                            propertyName = currentNode.property.name;
                        }
                        return object[propertyName];
                    }

                    // Build a readable path like [member:e.Rut.toString] for unresolved member expressions
                    const memberParts: string[] = [];
                    let memberWalker: any = currentNode;
                    while (
                        memberWalker &&
                        memberWalker.type === "MemberExpression" &&
                        !memberWalker.computed &&
                        memberWalker.property.type === "Identifier"
                    ) {
                        memberParts.unshift(memberWalker.property.name);
                        memberWalker = memberWalker.object;
                    }
                    if (memberWalker && memberWalker.type === "Identifier" && memberParts.length > 0) {
                        memberParts.unshift(memberWalker.name);
                        return `[member:${memberParts.join(".")}]`;
                    }
                    return `[unresolved member expression]`;
                }
                case "CallExpression": {
                    if (
                        currentNode.callee.type === "MemberExpression" &&
                        currentNode.callee.property.type === "Identifier" &&
                        currentNode.callee.property.name === "toString"
                    ) {
                        currentNode = currentNode.callee.object;
                        continue;
                    }

                    // For axios, try to resolve the callee if it's a webpack chunk import MemberExpression
                    if (
                        callType === "axios" &&
                        currentNode.callee.type === "MemberExpression" &&
                        chunkCode &&
                        chunks &&
                        thirdArgName
                    ) {
                        // Try to resolve the callee as a webpack chunk import
                        const memberExpr = currentNode.callee;

                        // Collect the full member expression path
                        const memberPath: string[] = [];
                        let tempNode: Node = memberExpr;

                        // Traverse backwards to collect the path
                        while (tempNode.type === "MemberExpression") {
                            if (tempNode.property.type === "Identifier") {
                                memberPath.unshift(tempNode.property.name);
                            }
                            tempNode = tempNode.object;
                        }

                        // Get the root identifier
                        if (tempNode.type === "Identifier") {
                            const rootIdentifier = tempNode.name;

                            // Try to resolve using webpack chunk import
                            const resolved = resolveWebpackChunkImport(
                                rootIdentifier,
                                chunkCode,
                                chunks,
                                thirdArgName,
                                memberPath
                            );

                            // If resolved successfully (not an error message), return it
                            // console.log(`[DEBUG] Webpack resolved value: ${typeof resolved === 'object' ? JSON.stringify(resolved) : resolved}, starts with unresolved: ${String(resolved).startsWith("[unresolved:")}, starts with error: ${String(resolved).startsWith("[error")}`);
                            if (
                                resolved &&
                                !String(resolved).startsWith("[unresolved:") &&
                                !String(resolved).startsWith("[error")
                            ) {
                                // console.log(`[DEBUG] RETURNING webpack resolved value: ${resolved}`);
                                return resolved;
                            }
                        }
                    }

                    let calleeName = "[unknown]";
                    if (currentNode.callee.type === "Identifier") {
                        calleeName = currentNode.callee.name;
                    }

                    // a lot of times, things like `"".concat(var1).concat(var2)` - which is basically multiple
                    // .concat() with varying arguments end up here. They needs to be resolved as a string

                    // first, match as regex
                    // Bound the probe length before running this regex against attacker-controlled bundle
                    // text: the nested `(\.concat\(.+\))+` quantifiers are catastrophically backtracking on
                    // crafted input, so a maliciously long node could hang the analysis pipeline.
                    const MAX_CONCAT_PROBE_LENGTH = 2000;
                    const normalizedNodeCode = nodeCode.replace(/\n\s*/g, "");
                    if (
                        normalizedNodeCode.length <= MAX_CONCAT_PROBE_LENGTH &&
                        normalizedNodeCode.match(/^"[^"]*"(?:\.concat\([^()]*\))+$/)
                    ) {
                        // parse it separately with ast
                        let ast;
                        try {
                            ast = parser.parse(nodeCode, {
                                sourceType: "unambiguous",
                                plugins: ["jsx", "typescript"],
                                errorRecovery: true,
                            });
                        } catch {
                            break;
                        }

                        // get all the concat calls first. Like .concat(...)
                        // I want to only get concat() and nothing else. Also, it doesn't matter how many times they are called
                        const concatCalls: any[][] = [];

                        const getArgValue = (arg: Node): any => {
                            switch (arg.type) {
                                case "StringLiteral":
                                case "NumericLiteral":
                                case "BooleanLiteral":
                                    return arg.value;
                                case "NullLiteral":
                                    return null;
                                case "Identifier":
                                    return `[var ${arg.name}]`; // Format identifiers as [var name]
                                default:
                                    // @ts-expect-error -- arg.property is not narrowed to MemberExpression by this point
                                    return `[${arg.type} -> ${arg.type === "MemberExpression" ? arg.property?.name : ""}]`;
                            }
                        };

                        traverse(ast, {
                            CallExpression(path) {
                                // We only want to start from the outermost `concat` call.
                                if (
                                    path.node.callee.type !== "MemberExpression" ||
                                    path.node.callee.property.type !== "Identifier" ||
                                    path.node.callee.property.name !== "concat" ||
                                    path.parent.type === "MemberExpression"
                                ) {
                                    return;
                                }

                                let current: any = path.node;
                                while (
                                    current &&
                                    current.type === "CallExpression" &&
                                    current.callee.type === "MemberExpression"
                                ) {
                                    const args = current.arguments.map(getArgValue);
                                    concatCalls.unshift(args);
                                    current = current.callee.object;
                                }

                                if (current) {
                                    if (current.type === "StringLiteral") {
                                        concatCalls.unshift([current.value]);
                                    } else if (current.type === "Identifier") {
                                        concatCalls.unshift([`[var ${current.name}]`]);
                                    } else {
                                        concatCalls.unshift([
                                            `[${current.type} -> ${
                                                current.type === "MemberExpression" ? current.property?.name : ""
                                            }]`,
                                        ]);
                                    }
                                }

                                // Stop traversal once we've processed the chain.
                                path.stop();
                            },
                        });

                        // process the concatCalls to return a single string
                        if (concatCalls.length > 0) {
                            const toReturn = concatCalls.flat().join("");
                            return toReturn;
                        }
                    }

                    // Build a readable callee label for the placeholder
                    let calleeLabel = calleeName !== "[unknown]" ? calleeName : "";
                    if (!calleeLabel && currentNode.callee.type === "MemberExpression") {
                        const parts: string[] = [];
                        let c: any = currentNode.callee;
                        while (c.type === "MemberExpression" && !c.computed && c.property.type === "Identifier") {
                            parts.unshift(c.property.name);
                            c = c.object;
                        }
                        if (c.type === "Identifier") parts.unshift(c.name);
                        calleeLabel = parts.join(".");
                    }
                    return `[call:${calleeLabel || "?"}()]`;
                }
                case "AwaitExpression": {
                    currentNode = (currentNode as any).argument;
                    continue;
                }
                case "NewExpression": {
                    if (
                        currentNode.callee.type === "Identifier" &&
                        currentNode.callee.name === "URL" &&
                        currentNode.arguments.length > 0
                    ) {
                        currentNode = currentNode.arguments[0];
                        continue;
                    }
                    if (
                        currentNode.callee.type === "Identifier" &&
                        currentNode.callee.name === "URLSearchParams" &&
                        currentNode.arguments.length > 0
                    ) {
                        const spArg = currentNode.arguments[0];
                        // If the argument is a plain MemberExpression like `a.b`,
                        // emit a typed marker so the downstream caller-substitution
                        // pass knows this part of the URL is a query expansion of
                        // an object reference, not just an inert placeholder.
                        const memberChain = memberChainToString(spArg);
                        if (memberChain && spArg.type === "MemberExpression" && !(spArg as any).computed) {
                            return `[urlsearchparams:${memberChain}]`;
                        }
                        if (spArg.type === "ObjectExpression") {
                            const params: string[] = [];
                            for (const prop of spArg.properties) {
                                if (prop.type !== "ObjectProperty") continue;
                                const key =
                                    prop.key.type === "Identifier"
                                        ? prop.key.name
                                        : prop.key.type === "StringLiteral"
                                          ? prop.key.value
                                          : null;
                                if (!key) continue;
                                const val = resolveNodeValue(
                                    prop.value,
                                    scope,
                                    nodeCode,
                                    callType,
                                    chunkCode,
                                    chunks,
                                    thirdArgName
                                );
                                if (val === "[call_stack_exceeded_use_better_machine]") return val;
                                // Use the literal value when fully resolved; otherwise use {key} as placeholder.
                                const valStr =
                                    val !== null && val !== undefined && !String(val).startsWith("[")
                                        ? encodeURIComponent(String(val))
                                        : `{${key}}`;
                                params.push(`${key}=${valStr}`);
                            }
                            if (params.length > 0) return params.join("&");
                        }
                        // Non-object arg — try to resolve it directly
                        const spResolved = resolveNodeValue(
                            spArg,
                            scope,
                            nodeCode,
                            callType,
                            chunkCode,
                            chunks,
                            thirdArgName
                        );
                        if (
                            spResolved !== null &&
                            spResolved !== undefined &&
                            spResolved !== "[call_stack_exceeded_use_better_machine]"
                        ) {
                            return String(spResolved);
                        }
                    }
                    return `[unresolved new expression]`;
                }
                case "LogicalExpression": {
                    const left = resolveNodeValue(
                        currentNode.left,
                        scope,
                        nodeCode,
                        callType,
                        chunkCode,
                        chunks,
                        thirdArgName
                    );
                    if (left === "[call_stack_exceeded_use_better_machine]") {
                        return left;
                    } else if (left && !String(left).startsWith("[")) {
                        return left;
                    }
                    currentNode = currentNode.right;
                    continue;
                }
                case "ConditionalExpression": {
                    const consequent = resolveNodeValue(
                        currentNode.consequent,
                        scope,
                        nodeCode,
                        callType,
                        chunkCode,
                        chunks,
                        thirdArgName
                    );
                    if (consequent === "[call_stack_exceeded_use_better_machine]") {
                        return consequent;
                    } else if (consequent && !String(consequent).startsWith("[")) {
                        return consequent;
                    }
                    currentNode = currentNode.alternate;
                    continue;
                }
                case "BinaryExpression": {
                    const left = resolveNodeValue(
                        currentNode.left,
                        scope,
                        nodeCode,
                        callType,
                        chunkCode,
                        chunks,
                        thirdArgName
                    );
                    if (left === "[call_stack_exceeded_use_better_machine]") {
                        return left;
                    }
                    const right = resolveNodeValue(
                        currentNode.right,
                        scope,
                        nodeCode,
                        callType,
                        chunkCode,
                        chunks,
                        thirdArgName
                    );
                    if (right === "[call_stack_exceeded_use_better_machine]") {
                        return right;
                    }
                    if (currentNode.operator === "+") {
                        const leftOk = left !== null && left !== undefined;
                        const rightOk = right !== null && right !== undefined;
                        // Fully resolved — concatenate directly.
                        if (leftOk && rightOk && !String(left).startsWith("[") && !String(right).startsWith("[")) {
                            return left + right;
                        }
                        // Partially resolved — concatenate what we have so the caller
                        // at least sees the resolvable fragments alongside the placeholders.
                        if (leftOk && rightOk) {
                            return `${left}${right}`;
                        }
                        if (leftOk) return String(left);
                        if (rightOk) return String(right);
                    }
                    return `[unresolved binary expression: ${currentNode.operator}]`;
                }
                case "ArrayExpression": {
                    const elements: any[] = [];
                    for (const element of currentNode.elements) {
                        if (element === null) {
                            elements.push(null);
                            continue;
                        }
                        const resolved = resolveNodeValue(
                            element,
                            scope,
                            nodeCode,
                            callType,
                            chunkCode,
                            chunks,
                            thirdArgName
                        );
                        if (resolved === "[call_stack_exceeded_use_better_machine]") return resolved;
                        elements.push(resolved);
                    }
                    return elements;
                }
                case "UnaryExpression": {
                    if (currentNode.operator === "void") return null;
                    const operand = resolveNodeValue(
                        (currentNode as any).argument,
                        scope,
                        nodeCode,
                        callType,
                        chunkCode,
                        chunks,
                        thirdArgName
                    );
                    if (operand === "[call_stack_exceeded_use_better_machine]") return operand;
                    if (currentNode.operator === "!") {
                        if (typeof operand === "boolean") return !operand;
                        if (typeof operand === "number") return operand === 0;
                        return "<boolean>";
                    }
                    if (currentNode.operator === "-") {
                        if (typeof operand === "number") return -operand;
                        return "<number>";
                    }
                    if (currentNode.operator === "typeof") return "<string>";
                    return "<unknown>";
                }
                default:
                    return `[unsupported node type: ${currentNode.type}]`;
            }
        }
        return null;
    } catch (e) {
        // check if it's a "Maximum call stack size exceeded" error
        if (e instanceof RangeError && e.message.includes("Maximum call stack size exceeded")) {
            return "[call_stack_exceeded_use_better_machine]";
            // console.error("[error] Maximum call stack size exceeded. Please use a better machine.");
            // process.exit(21);
        }
    }
};

/**
 * Resolves string concatenation operations to flatten concat chains.
 *
 * Handles patterns like '"/api/teams/".concat(i, "/members")' by:
 * - Parsing the string literal and concat arguments
 * - Replacing variables with placeholder strings like '[var name]'
 * - Flattening the entire concatenation chain into a single string
 * - Respecting quoted strings and handling nested expressions
 *
 * @param rawExpr - The raw expression string containing concat operations
 * @returns Flattened string with variable placeholders
 */
export const resolveStringOps = (rawExpr: string): string => {
    if (!rawExpr || typeof rawExpr !== "string") return rawExpr;

    // Quick check for pattern "<string literal>.concat(... )"
    const concatMatch = rawExpr.match(/^(\s*["'`])(.*?)(\1)\.concat\(([\s\S]*)\)$/);
    if (!concatMatch) {
        // Not in expected pattern – return as-is for now.
        return rawExpr;
    }

    const leadingLiteral = concatMatch[2];
    const argsPart = concatMatch[4]; // everything inside the concat(...)

    // Split arguments respecting quotes. We'll do a naive split on commas that are not inside quotes.
    const args: string[] = [];
    let current = "";
    let inSingle = false;
    let inDouble = false;
    let inBacktick = false;

    for (let i = 0; i < argsPart.length; i++) {
        const ch = argsPart[i];
        if (ch === "'" && !inDouble && !inBacktick) {
            inSingle = !inSingle;
            current += ch;
            continue;
        }
        if (ch === '"' && !inSingle && !inBacktick) {
            inDouble = !inDouble;
            current += ch;
            continue;
        }
        if (ch === "`" && !inSingle && !inDouble) {
            inBacktick = !inBacktick;
            current += ch;
            continue;
        }
        if (ch === "," && !inSingle && !inDouble && !inBacktick) {
            args.push(current.trim());
            current = "";
            continue;
        }
        current += ch;
    }
    if (current.trim() !== "") args.push(current.trim());

    // Build resolved string
    let result = leadingLiteral;
    for (const arg of args) {
        const trimmed = arg.trim();
        if (/^['"`].*['"`]$/.test(trimmed)) {
            // string literal – strip quotes
            result += trimmed.slice(1, -1);
        } else if (trimmed.length) {
            // treat as identifier / expression – replace with placeholder
            // attempt to extract simple identifier name if possible
            const idMatch = trimmed.match(/^[a-zA-Z_$][a-zA-Z0-9_$]*/);
            const idName = idMatch ? idMatch[0] : trimmed;
            result += `[var ${idName}]`;
        }
    }

    return result;
};
