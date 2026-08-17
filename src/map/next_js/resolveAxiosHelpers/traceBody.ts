import { NodePath } from "@babel/traverse";
import traverse from "@babel/traverse";
import * as parser from "@babel/parser";
import { Node } from "@babel/types";
import { Chunks } from "../../../utility/interfaces.js";
import { astNodeToJsonString } from "./astNodeToJsonString.js";

// AST parse cache keyed by chunk id, so that cross-chunk tracing doesn't reparse
// the same chunk file dozens of times across recursive calls.
const astCache: Map<string, any> = new Map();
const parseChunkAst = (chunkId: string, code: string): any | null => {
    const cached = astCache.get(chunkId);
    if (cached !== undefined) return cached;
    try {
        const ast = parser.parse(code, {
            sourceType: "unambiguous",
            plugins: ["jsx", "typescript"],
            errorRecovery: true,
        });
        astCache.set(chunkId, ast);
        return ast;
    } catch {
        astCache.set(chunkId, null);
        return null;
    }
};

/**
 * Resolves an Identifier value by walking variable initializers in scope.
 *
 * Used when an object property is assigned an identifier like `{username: e, password: t}` —
 * we follow `e` to its declaration to find the real shape (e.g. another property of a state
 * value or a string literal).
 */
// Reconstruct a dotted-path string for `a.b.c` / `a["b"]` / `this.x` chains so
// downstream consumers see `"e.ssn"` instead of the raw `"[MemberExpression]"`
// AST-tag fallback.
const memberExpressionToString = (node: any): string => {
    if (!node) return "?";
    if (node.type === "Identifier") return node.name;
    if (node.type === "ThisExpression") return "this";
    if (node.type === "MemberExpression") {
        const obj = memberExpressionToString(node.object);
        if (node.computed) {
            if (node.property.type === "StringLiteral") return `${obj}["${node.property.value}"]`;
            if (node.property.type === "NumericLiteral") return `${obj}[${node.property.value}]`;
            return `${obj}[?]`;
        }
        if (node.property.type === "Identifier") return `${obj}.${node.property.name}`;
        return `${obj}.?`;
    }
    return "?";
};

const resolvePropertyValueNode = (node: Node, scopePath: NodePath, depth: number = 0): string => {
    if (depth > 6) return `"<unknown>"`;
    if (!node) return `""`;

    if (node.type === "Identifier") {
        const binding = scopePath.scope.getBinding(node.name);
        if (binding && binding.path.isVariableDeclarator() && binding.path.node.init) {
            return resolvePropertyValueNode(binding.path.node.init, binding.path, depth + 1);
        }
        return `"<unknown>"`;
    }

    if (node.type === "ObjectExpression") {
        const props = node.properties
            .map((prop: any) => {
                if (prop.type === "ObjectProperty") {
                    let key = "";
                    if (prop.key.type === "Identifier") key = prop.key.name;
                    else if (prop.key.type === "StringLiteral") key = prop.key.value;
                    else key = "[unresolved key]";
                    const value = resolvePropertyValueNode(prop.value, scopePath, depth + 1);
                    return `"${key}": ${value}`;
                }
                if (prop.type === "SpreadElement") {
                    return `"...": ${resolvePropertyValueNode(prop.argument, scopePath, depth + 1)}`;
                }
                return null;
            })
            .filter(Boolean);
        return `{${props.join(", ")}}`;
    }

    if (node.type === "StringLiteral") return JSON.stringify(node.value);
    if (node.type === "NumericLiteral") return String(node.value);
    if (node.type === "BooleanLiteral") return String(node.value);
    if (node.type === "NullLiteral") return "null";

    if (node.type === "MemberExpression") {
        return JSON.stringify(memberExpressionToString(node));
    }

    // `new Date(...)` is the only NewExpression that shows up in practice (date
    // pickers materializing `new Date(value)` before the POST). Treat it as a
    // date placeholder; everything else degrades to "<unknown>".
    if (node.type === "NewExpression") {
        const callee: any = (node as any).callee;
        if (callee && callee.type === "Identifier" && callee.name === "Date") return `"<date>"`;
        return `"<unknown>"`;
    }

    if (node.type === "TemplateLiteral") return `"<string>"`;
    if (node.type === "ArrayExpression") return `["<array>"]`;
    if (node.type === "CallExpression") return `"<unknown>"`;
    if (node.type === "ConditionalExpression") {
        return resolvePropertyValueNode((node as any).consequent, scopePath, depth + 1);
    }
    if (node.type === "LogicalExpression") {
        return resolvePropertyValueNode((node as any).left, scopePath, depth + 1);
    }
    if (node.type === "UnaryExpression" && (node as any).operator === "void") return `"<unknown>"`;

    return `"<unknown>"`;
};

/**
 * Builds a JSON-like body string from an ObjectExpression argument, resolving identifier
 * property values via Babel scope where possible.
 */
const objectExpressionToBody = (node: any, scopePath: NodePath): string => {
    const props = node.properties
        .map((prop: any) => {
            if (prop.type === "ObjectProperty") {
                let key = "";
                if (prop.key.type === "Identifier") key = prop.key.name;
                else if (prop.key.type === "StringLiteral") key = prop.key.value;
                else key = "[unresolved key]";
                const value = resolvePropertyValueNode(prop.value, scopePath, 0);
                return `"${key}": ${value}`;
            }
            if (prop.type === "SpreadElement") {
                return `"...": ${resolvePropertyValueNode(prop.argument, scopePath, 0)}`;
            }
            return null;
        })
        .filter(Boolean);
    return `{${props.join(", ")}}`;
};

type SchemaRef = { kind: "local"; name: string } | { kind: "cross"; importVar: string; exportName: string };

/**
 * Walks any zod-style schema initializer to extract the keys that will end up in
 * the parsed value, even when the schema is composed of chained builder calls
 * (extend / merge / pick / omit / partial / required / passthrough / strict / etc.).
 *
 * Supports cross-chunk references when `chunks` + `chunkId` + `thirdArgName` are
 * supplied: `let x = thirdArg(NNN); x.SCHEMA.extend(...)`.
 */
const buildSchemaFromInitNode = (
    initNode: any,
    ast: Node,
    chunks: Chunks | undefined,
    chunkId: string | undefined,
    thirdArgName: string | null,
    visited: Set<string> = new Set(),
    depth: number = 0
): { fields: Map<string, any>; pickKeys?: Set<string>; omitKeys?: Set<string> } | null => {
    if (depth > 8) return null;
    if (!initNode) return null;

    // Schema reference: an Identifier pointing to another schema variable in this chunk.
    if (initNode.type === "Identifier") {
        return resolveSchemaVarToFields(initNode.name, ast, chunks, chunkId, thirdArgName, visited, depth + 1);
    }

    // Cross-chunk reference: `x.SCHEMA` where `x = thirdArg(NNN)`.
    if (
        initNode.type === "MemberExpression" &&
        initNode.property.type === "Identifier" &&
        initNode.object.type === "Identifier"
    ) {
        const result = resolveCrossChunkSchemaRef(
            initNode.object.name,
            initNode.property.name,
            ast,
            chunks,
            chunkId,
            thirdArgName,
            visited,
            depth + 1
        );
        if (result) return result;
    }

    if (initNode.type === "CallExpression" && initNode.callee.type === "MemberExpression") {
        const methodName = initNode.callee.property.type === "Identifier" ? initNode.callee.property.name : null;
        const base = initNode.callee.object;
        const arg0 = initNode.arguments[0];

        // <X>.object({ ... }) — terminal: the keys are the object literal's properties.
        if (methodName === "object" && arg0 && arg0.type === "ObjectExpression") {
            const fields = new Map<string, any>();
            for (const prop of arg0.properties) {
                if (prop.type !== "ObjectProperty") continue;
                let key = "";
                if ((prop.key as any).type === "Identifier") key = (prop.key as any).name;
                else if ((prop.key as any).type === "StringLiteral") key = (prop.key as any).value;
                else continue;
                fields.set(key, prop.value);
            }
            return { fields };
        }

        // <base>.extend({ ... }) or <base>.merge(<schema>) — accumulate the base's
        // fields then add the extension's.
        if (methodName === "extend" || methodName === "merge") {
            const baseResult = buildSchemaFromInitNode(
                base,
                ast,
                chunks,
                chunkId,
                thirdArgName,
                visited,
                depth + 1
            ) ?? {
                fields: new Map(),
            };

            if (arg0 && arg0.type === "ObjectExpression") {
                for (const prop of arg0.properties) {
                    if (prop.type !== "ObjectProperty") continue;
                    let key = "";
                    if ((prop.key as any).type === "Identifier") key = (prop.key as any).name;
                    else if ((prop.key as any).type === "StringLiteral") key = (prop.key as any).value;
                    else continue;
                    baseResult.fields.set(key, prop.value);
                }
            } else if (arg0) {
                const extResult = buildSchemaFromInitNode(arg0, ast, chunks, chunkId, thirdArgName, visited, depth + 1);
                if (extResult) {
                    for (const [k, v] of extResult.fields) baseResult.fields.set(k, v);
                }
            }
            return baseResult;
        }

        // <base>.pick({ keyA: true, keyB: true }) / .omit(...) — narrow the field set.
        // The pick/omit spec may be an inline ObjectExpression *or* an Identifier
        // pointing to a `let spec = { keyA: !0, ... }` declaration earlier in the chunk.
        if (methodName === "pick" || methodName === "omit") {
            let specObj: any = null;
            if (arg0 && arg0.type === "ObjectExpression") {
                specObj = arg0;
            } else if (arg0 && arg0.type === "Identifier") {
                traverse(ast as any, {
                    VariableDeclarator(p) {
                        if (specObj) return;
                        if (
                            p.node.id.type === "Identifier" &&
                            p.node.id.name === arg0.name &&
                            p.node.init &&
                            p.node.init.type === "ObjectExpression"
                        ) {
                            specObj = p.node.init;
                            p.stop();
                        }
                    },
                });
            }
            if (!specObj) {
                return buildSchemaFromInitNode(base, ast, chunks, chunkId, thirdArgName, visited, depth + 1);
            }
            const keys = new Set<string>();
            for (const prop of specObj.properties) {
                if (prop.type !== "ObjectProperty") continue;
                let key = "";
                if ((prop.key as any).type === "Identifier") key = (prop.key as any).name;
                else if ((prop.key as any).type === "StringLiteral") key = (prop.key as any).value;
                else continue;
                keys.add(key);
            }
            const baseResult = buildSchemaFromInitNode(base, ast, chunks, chunkId, thirdArgName, visited, depth + 1);
            if (!baseResult) return { fields: new Map(), [methodName === "pick" ? "pickKeys" : "omitKeys"]: keys };
            if (methodName === "pick") {
                const filtered = new Map<string, any>();
                for (const [k, v] of baseResult.fields) {
                    if (keys.has(k)) filtered.set(k, v);
                }
                return { fields: filtered };
            } else {
                const filtered = new Map<string, any>();
                for (const [k, v] of baseResult.fields) {
                    if (!keys.has(k)) filtered.set(k, v);
                }
                return { fields: filtered };
            }
        }

        // Pass-through wrappers — schema stays the same.
        if (
            methodName === "partial" ||
            methodName === "required" ||
            methodName === "passthrough" ||
            methodName === "strict" ||
            methodName === "strip" ||
            methodName === "describe" ||
            methodName === "refine" ||
            methodName === "superRefine" ||
            methodName === "transform" ||
            methodName === "default" ||
            methodName === "optional" ||
            methodName === "nullable" ||
            methodName === "nullish" ||
            methodName === "readonly" ||
            methodName === "brand" ||
            methodName === "catch" ||
            methodName === "innerType" ||
            methodName === "unwrap" ||
            methodName === "removeDefault" ||
            methodName === "removeCatch" ||
            methodName === "promise" ||
            methodName === "array"
        ) {
            return buildSchemaFromInitNode(base, ast, chunks, chunkId, thirdArgName, visited, depth + 1);
        }
    }

    return null;
};

/**
 * Resolves a local schema variable name to its keys, recursively chasing through
 * builder chains and aliases.
 */
const resolveSchemaVarToFields = (
    varName: string,
    ast: Node,
    chunks: Chunks | undefined,
    chunkId: string | undefined,
    thirdArgName: string | null,
    visited: Set<string>,
    depth: number
): { fields: Map<string, any> } | null => {
    const cycleKey = `${chunkId ?? "_"}:${varName}`;
    if (visited.has(cycleKey)) return null;
    visited.add(cycleKey);

    let initNode: any = null;
    traverse(ast as any, {
        VariableDeclarator(p) {
            if (initNode) return;
            if (p.node.id.type === "Identifier" && p.node.id.name === varName && p.node.init) {
                initNode = p.node.init;
                p.stop();
            }
        },
    });
    if (!initNode) return null;

    const built = buildSchemaFromInitNode(initNode, ast, chunks, chunkId, thirdArgName, visited, depth);
    return built ? { fields: built.fields } : null;
};

/**
 * Resolves `<importVar>.<exportName>` where `<importVar> = <thirdArg>(<chunkId>)`,
 * locating the corresponding schema in the imported chunk.
 */
const resolveCrossChunkSchemaRef = (
    importVar: string,
    exportName: string,
    ast: Node,
    chunks: Chunks | undefined,
    _chunkId: string | undefined,
    thirdArgName: string | null,
    visited: Set<string>,
    depth: number
): { fields: Map<string, any> } | null => {
    if (!chunks || !thirdArgName) return null;

    // Identify which chunk `importVar` points to in the current chunk.
    let targetChunkId: string | null = null;
    traverse(ast as any, {
        VariableDeclarator(p) {
            if (targetChunkId) return;
            if (
                p.node.id.type === "Identifier" &&
                p.node.id.name === importVar &&
                p.node.init &&
                p.node.init.type === "CallExpression" &&
                p.node.init.callee.type === "Identifier" &&
                p.node.init.callee.name === thirdArgName &&
                p.node.init.arguments.length === 1 &&
                p.node.init.arguments[0].type === "NumericLiteral"
            ) {
                targetChunkId = String((p.node.init.arguments[0] as any).value);
                p.stop();
            }
        },
    });

    if (!targetChunkId || !chunks[targetChunkId]) return null;

    const targetChunk = chunks[targetChunkId];
    const targetAst = parseChunkAst(targetChunkId, targetChunk.code);
    if (!targetAst) return null;

    // Find which local variable backs the requested export.
    let exportVarName: string | null = null;
    traverse(targetAst, {
        CallExpression(p) {
            if (exportVarName) return;
            const callee = p.node.callee;
            if (
                callee.type !== "MemberExpression" ||
                callee.property.type !== "Identifier" ||
                callee.property.name !== "d" ||
                p.node.arguments.length !== 2 ||
                p.node.arguments[1].type !== "ObjectExpression"
            ) {
                return;
            }
            for (const prop of (p.node.arguments[1] as any).properties) {
                if (prop.type !== "ObjectProperty" || prop.key.type !== "Identifier" || prop.key.name !== exportName) {
                    continue;
                }
                const value = prop.value;
                if (value.type !== "FunctionExpression" && value.type !== "ArrowFunctionExpression") continue;
                let returnNode: any = null;
                if (value.type === "ArrowFunctionExpression" && value.body.type !== "BlockStatement") {
                    returnNode = value.body;
                } else if (value.body.type === "BlockStatement") {
                    const ret = value.body.body.find((s: any) => s.type === "ReturnStatement");
                    if (ret) returnNode = (ret as any).argument;
                }
                if (returnNode && returnNode.type === "Identifier") {
                    exportVarName = returnNode.name;
                    return;
                }
            }
        },
    });
    if (!exportVarName) return null;

    const targetThirdArg = findThirdArgInAst(targetAst);
    return resolveSchemaVarToFields(exportVarName, targetAst, chunks, targetChunkId, targetThirdArg, visited, depth);
};

const zodTypeToPlaceholder = (valueNode: any): string => {
    if (!valueNode) return `"<unknown>"`;
    let cur = valueNode;
    while (
        cur &&
        cur.type === "CallExpression" &&
        cur.callee.type === "MemberExpression" &&
        cur.callee.property.type === "Identifier" &&
        [
            "optional",
            "nullable",
            "nullish",
            "min",
            "max",
            "length",
            "email",
            "url",
            "uuid",
            "regex",
            "trim",
            "default",
            "describe",
            "refine",
            "transform",
            "superRefine",
        ].includes(cur.callee.property.name)
    ) {
        cur = cur.callee.object;
    }

    if (
        cur &&
        cur.type === "CallExpression" &&
        cur.callee.type === "MemberExpression" &&
        cur.callee.property.type === "Identifier"
    ) {
        const name = cur.callee.property.name;
        switch (name) {
            case "string":
                return `"<string>"`;
            case "number":
                return `"<number>"`;
            case "boolean":
                return `"<boolean>"`;
            case "bigint":
                return `"<bigint>"`;
            case "date":
                return `"<date>"`;
            case "array":
                return `["<array>"]`;
            case "object":
                if (cur.arguments.length === 1 && cur.arguments[0].type === "ObjectExpression") {
                    return fieldsObjectToString(cur.arguments[0]);
                }
                return `"<object>"`;
            case "enum":
                return `"<enum>"`;
            case "literal":
                if (cur.arguments.length === 1 && cur.arguments[0].type === "StringLiteral") {
                    return JSON.stringify(cur.arguments[0].value);
                }
                return `"<literal>"`;
            case "coerce":
                return `"<coerce>"`;
            default:
                return `"<${name}>"`;
        }
    }

    return `"<unknown>"`;
};

const fieldsObjectToString = (objNode: any): string => {
    const parts = objNode.properties
        .map((prop: any) => {
            if (prop.type !== "ObjectProperty") return null;
            let key = "";
            if (prop.key.type === "Identifier") key = prop.key.name;
            else if (prop.key.type === "StringLiteral") key = prop.key.value;
            else return null;
            return `"${key}": ${zodTypeToPlaceholder(prop.value)}`;
        })
        .filter(Boolean);
    return `{${parts.join(", ")}}`;
};

const fieldsMapToString = (fields: Map<string, any>): string => {
    const parts: string[] = [];
    for (const [k, v] of fields) {
        parts.push(`"${k}": ${zodTypeToPlaceholder(v)}`);
    }
    return `{${parts.join(", ")}}`;
};

/**
 * Discovers zod-style schemas in the chunk (e.g. `let w = x.z.object({...})`,
 * `objectSchema: o.VG`) and converts them to a JSON-like body shape.
 *
 * Preference order:
 *   1. Schemas referenced via `objectSchema:` or `resolver:` JSX props. Supports
 *      both local Identifiers and cross-chunk MemberExpressions (`o.VG`).
 *      Multiple matches are merged so multi-step forms whose final POST body is
 *      the union of all step schemas come out closer to reality.
 *   2. The first standalone `z.object({...})` definition in the chunk.
 */
const findZodSchemaInChunk = (
    ast: Node,
    chunks?: Chunks,
    chunkId?: string,
    thirdArgName?: string | null
): string | null => {
    const schemaRefs: SchemaRef[] = [];

    traverse(ast as any, {
        ObjectProperty(p) {
            const key = p.node.key as any;
            const keyName = key.type === "Identifier" ? key.name : key.type === "StringLiteral" ? key.value : null;
            const value: any = p.node.value;
            const captureFromValue = (v: any) => {
                if (!v) return;
                if (v.type === "Identifier") {
                    schemaRefs.push({ kind: "local", name: v.name });
                } else if (
                    v.type === "MemberExpression" &&
                    v.object.type === "Identifier" &&
                    v.property.type === "Identifier"
                ) {
                    schemaRefs.push({ kind: "cross", importVar: v.object.name, exportName: v.property.name });
                }
            };
            if (keyName === "objectSchema") {
                captureFromValue(value);
            } else if (keyName === "resolver" && value.type === "CallExpression" && value.arguments.length > 0) {
                captureFromValue(value.arguments[0]);
            }
        },
    });

    const resolvedFieldMaps: Map<string, any>[] = [];
    const seen = new Set<string>();
    for (const ref of schemaRefs) {
        const key = ref.kind === "local" ? `L:${ref.name}` : `X:${ref.importVar}.${ref.exportName}`;
        if (seen.has(key)) continue;
        seen.add(key);

        // Each top-level schema ref starts with a fresh visited set — otherwise
        // resolving the first schema would block the second from following
        // shared base schemas (e.g. multi-step forms where every step extends
        // the same `p`).
        const refVisited = new Set<string>();
        let resolved: { fields: Map<string, any> } | null = null;
        if (ref.kind === "local") {
            resolved = resolveSchemaVarToFields(ref.name, ast, chunks, chunkId, thirdArgName ?? null, refVisited, 0);
        } else {
            resolved = resolveCrossChunkSchemaRef(
                ref.importVar,
                ref.exportName,
                ast,
                chunks,
                chunkId,
                thirdArgName ?? null,
                refVisited,
                0
            );
        }
        if (resolved && resolved.fields.size > 0) {
            resolvedFieldMaps.push(resolved.fields);
        }
    }

    if (resolvedFieldMaps.length > 0) {
        // Merge fields from all referenced schemas. For multi-step forms this gives
        // the union — the final POST body is generally the accumulated form state.
        const merged = new Map<string, any>();
        for (const fields of resolvedFieldMaps) {
            for (const [k, v] of fields) merged.set(k, v);
        }
        return fieldsMapToString(merged);
    }

    // Fallback: the first standalone `<X>.object({...})` in the chunk.
    let schemaNode: any = null;
    traverse(ast as any, {
        CallExpression(p) {
            if (schemaNode) return;
            const callee = p.node.callee;
            if (
                callee.type === "MemberExpression" &&
                callee.property.type === "Identifier" &&
                callee.property.name === "object" &&
                p.node.arguments.length === 1 &&
                p.node.arguments[0].type === "ObjectExpression"
            ) {
                schemaNode = p.node.arguments[0];
                p.stop();
            }
        },
    });

    if (!schemaNode) return null;
    return fieldsObjectToString(schemaNode);
};

/**
 * Finds the webpack-export name a local function is exposed under.
 *
 * Webpack emits exports as:
 *   <thirdArg>.d(<exportObj>, { EXPNAME: function() { return funcName; } })
 *
 * Given `funcName`, returns the matching `EXPNAME` (or null if not exported).
 */
const findExportNameForFunc = (ast: Node, funcName: string): string | null => {
    let exportName: string | null = null;
    traverse(ast as any, {
        CallExpression(p) {
            if (exportName) return;
            const callee = p.node.callee;
            if (callee.type !== "MemberExpression") return;
            if (callee.property.type !== "Identifier" || callee.property.name !== "d") return;
            if (p.node.arguments.length !== 2) return;
            if (p.node.arguments[1].type !== "ObjectExpression") return;

            for (const prop of (p.node.arguments[1] as any).properties) {
                if (prop.type !== "ObjectProperty" || prop.key.type !== "Identifier") continue;
                const value = prop.value;
                if (value.type !== "FunctionExpression" && value.type !== "ArrowFunctionExpression") continue;

                let returnNode: any = null;
                if (value.type === "ArrowFunctionExpression" && value.body.type !== "BlockStatement") {
                    returnNode = value.body;
                } else if (value.body.type === "BlockStatement") {
                    const ret = value.body.body.find((s: any) => s.type === "ReturnStatement");
                    if (ret) returnNode = (ret as any).argument;
                }

                if (returnNode && returnNode.type === "Identifier" && returnNode.name === funcName) {
                    exportName = prop.key.name;
                    return;
                }
            }
        },
    });
    return exportName;
};

/**
 * Finds the third parameter (webpack-require) name of a module function in an AST.
 *
 * Webpack module wrappers look like `function (e, t, n) { ... }` or
 * `MODULE_ID: function (e, t, n) { ... }`. The third param is the require function
 * used to import other chunks: `var X = n(<chunkId>)`.
 */
const findThirdArgInAst = (ast: Node): string | null => {
    let thirdArg: string | null = null;
    traverse(ast as any, {
        Function(p) {
            if (thirdArg) return;
            const fn: any = p.node;
            if (fn.params && fn.params.length === 3 && fn.params[2].type === "Identifier") {
                thirdArg = fn.params[2].name;
                p.stop();
            }
        },
    });
    return thirdArg;
};

/**
 * Cross-chunk callsite trace.
 *
 * When a wrapper function (e.g. `let i = (t, e) => axios.post("/url", t, e)`) has
 * no local callsites — typical for "service module" chunks whose only purpose is
 * to export wrappers — search every chunk that imports the current chunk, look
 * for invocations of the corresponding export (`x.cr(args)` or `(0, x.cr)(args)`),
 * and recurse into the body argument's identifier in that scope.
 */
const crossChunkTrace = (
    funcName: string,
    paramIndex: number,
    currentChunkId: string,
    currentAst: Node,
    chunks: Chunks,
    visited: Set<string>,
    depth: number
): string | null => {
    const exportName = findExportNameForFunc(currentAst, funcName);
    if (!exportName) return null;

    for (const [otherChunkId, otherChunk] of Object.entries(chunks)) {
        if (otherChunkId === currentChunkId) continue;
        if (!otherChunk.imports || !otherChunk.imports.includes(currentChunkId)) continue;

        const otherAst = parseChunkAst(otherChunkId, otherChunk.code);
        if (!otherAst) continue;

        const otherThirdArg = findThirdArgInAst(otherAst);
        if (!otherThirdArg) continue;

        // Find every variable that is `<otherThirdArg>(<currentChunkId>)`.
        const importVarNames: Set<string> = new Set();
        traverse(otherAst, {
            VariableDeclarator(p) {
                if (
                    p.node.id.type === "Identifier" &&
                    p.node.init &&
                    p.node.init.type === "CallExpression" &&
                    p.node.init.callee.type === "Identifier" &&
                    p.node.init.callee.name === otherThirdArg &&
                    p.node.init.arguments.length === 1 &&
                    p.node.init.arguments[0].type === "NumericLiteral" &&
                    String((p.node.init.arguments[0] as any).value) === currentChunkId
                ) {
                    importVarNames.add(p.node.id.name);
                }
            },
        });

        if (importVarNames.size === 0) continue;

        let resolved: string | null = null;

        traverse(otherAst, {
            CallExpression(callPath) {
                if (resolved) return;

                // Unwrap (0, X.exp)(...) → callee is SequenceExpression whose last element
                // is the member expression we care about.
                let callee: any = callPath.node.callee;
                if (callee.type === "SequenceExpression") {
                    callee = callee.expressions[callee.expressions.length - 1];
                }

                if (
                    callee.type !== "MemberExpression" ||
                    callee.object.type !== "Identifier" ||
                    !importVarNames.has(callee.object.name) ||
                    callee.property.type !== "Identifier" ||
                    callee.property.name !== exportName
                ) {
                    return;
                }

                const argNode = callPath.node.arguments[paramIndex];
                if (!argNode) return;

                if (argNode.type === "ObjectExpression") {
                    resolved = objectExpressionToBody(argNode, callPath);
                    callPath.stop();
                    return;
                }

                if (argNode.type === "Identifier") {
                    const traced = traceIdentifierBody(
                        argNode.name,
                        callPath,
                        otherAst,
                        otherChunk.code,
                        chunks,
                        visited,
                        depth + 1,
                        otherChunkId
                    );
                    if (traced) {
                        resolved = traced;
                        callPath.stop();
                    }
                }
            },
        });

        if (resolved) return resolved;
    }

    return null;
};

/**
 * Traces a function-parameter identifier back through call sites to find its
 * actual body shape.
 *
 * Algorithm:
 *   1. Look up the binding for `paramName` in `path.scope`.
 *   2. If the binding is a function parameter, walk to the enclosing function,
 *      determine the parameter index, and find the function's bound name (if any).
 *   3. Search the current chunk's AST for direct call sites of that function. For
 *      each call site, inspect the argument at the same index:
 *        - If it's an ObjectExpression, convert it to a JSON-like body and return.
 *        - If it's an Identifier, recurse on it.
 *   4. If no local call site resolves the shape:
 *      a. Try cross-chunk tracing: find the chunk's export name for this function
 *         and recurse into every chunk that imports the export.
 *      b. As a last resort, fall back to discovering a zod schema in the same chunk.
 */
export const traceIdentifierBody = (
    paramName: string,
    path: NodePath,
    ast: Node,
    chunkCode: string,
    chunks: Chunks | undefined,
    visited: Set<string> = new Set(),
    depth: number = 0,
    chunkId?: string
): string | null => {
    if (depth > 6) return null;

    const binding = path.scope.getBinding(paramName);
    if (!binding) return null;

    // Non-parameter bindings (let / const / var) can still have a useful initializer
    // — most commonly `let r = { reportType: n.type, ...e }` immediately before an
    // axios call. Render the initializer's ObjectExpression directly when we have one.
    if (binding.kind !== "param") {
        if (binding.path.isVariableDeclarator() && binding.path.node.init) {
            const init: any = binding.path.node.init;
            if (init.type === "ObjectExpression") {
                return objectExpressionToBody(init, binding.path as NodePath);
            }
            if (init.type === "Identifier") {
                return traceIdentifierBody(
                    init.name,
                    binding.path as NodePath,
                    ast,
                    chunkCode,
                    chunks,
                    visited,
                    depth + 1,
                    chunkId
                );
            }
        }
        return null;
    }

    const funcPath = binding.path.find((p) => p.isFunction()) as NodePath | null;
    if (!funcPath) return null;

    const funcNode: any = funcPath.node;
    const paramIndex = funcNode.params.findIndex((p: any) => p.type === "Identifier" && p.name === paramName);
    if (paramIndex === -1) return null;

    let funcName: string | null = null;
    if (funcPath.isFunctionDeclaration() && funcNode.id?.type === "Identifier") {
        funcName = funcNode.id.name;
    } else if (funcPath.parentPath) {
        const parent: any = funcPath.parentPath.node;
        if (parent.type === "VariableDeclarator" && parent.id?.type === "Identifier") {
            funcName = parent.id.name;
        } else if (parent.type === "AssignmentExpression" && parent.left?.type === "Identifier") {
            funcName = parent.left.name;
        }
    }

    const localThirdArg = findThirdArgInAst(ast);

    if (!funcName) {
        return findZodSchemaInChunk(ast, chunks, chunkId, localThirdArg);
    }

    const cycleKey = `${chunkId ?? "_"}:${funcName}:${paramIndex}`;
    if (visited.has(cycleKey)) return null;
    visited.add(cycleKey);

    const targetFuncNode: Node = funcNode;

    let resolved: string | null = null;
    let directCallCount = 0;

    traverse(ast as any, {
        CallExpression(callPath) {
            if (resolved) return;
            const callee = callPath.node.callee;
            if (callee.type === "Identifier" && callee.name === funcName) {
                const callBinding = callPath.scope.getBinding(funcName);
                if (!callBinding) return;
                const callTargetFunc =
                    callBinding.path.isVariableDeclarator() && (callBinding.path.node as any).init
                        ? (callBinding.path.node as any).init
                        : callBinding.path.node;
                if (callTargetFunc !== targetFuncNode) {
                    return;
                }
                directCallCount++;
                const argNode = callPath.node.arguments[paramIndex];
                if (!argNode) return;

                if (argNode.type === "ObjectExpression") {
                    resolved = objectExpressionToBody(argNode, callPath);
                    callPath.stop();
                    return;
                }

                if (argNode.type === "Identifier") {
                    const traced = traceIdentifierBody(
                        argNode.name,
                        callPath,
                        ast,
                        chunkCode,
                        chunks,
                        visited,
                        depth + 1,
                        chunkId
                    );
                    if (traced) {
                        resolved = traced;
                        callPath.stop();
                    }
                }
            }
        },
    });

    if (resolved) return resolved;

    // No local resolution. Try cross-chunk callsite trace before falling back to
    // schema discovery — cross-chunk usually carries real call-site evidence,
    // while zod schemas in unrelated chunks are easy to misidentify.
    if (chunkId && chunks) {
        const crossChunk = crossChunkTrace(funcName, paramIndex, chunkId, ast, chunks, visited, depth);
        if (crossChunk) return crossChunk;
    }

    // Schema fallback. Used when:
    //   - the function is never called directly (only passed as a callback to a
    //     form/library), or
    //   - it *is* called locally but with state/non-traceable identifiers (so the
    //     local callsite gave us nothing).
    // The schema search prefers `objectSchema:` / `resolver:` JSX props, which
    // are usually the right wiring even when the handler's data flow is opaque.
    return findZodSchemaInChunk(ast, chunks, chunkId, localThirdArg);
};

/**
 * Convenience entry that converts the result back into something acceptable as a
 * `callBody` string. Returns null if no improvement is possible.
 */
export const maybeTraceBodyForIdentifier = (
    bodyArgNode: Node,
    parentCallPath: NodePath,
    ast: Node,
    chunkCode: string,
    chunks: Chunks | undefined,
    chunkId?: string
): string | null => {
    if (!bodyArgNode || bodyArgNode.type !== "Identifier") return null;
    const idName = (bodyArgNode as any).name as string;
    return traceIdentifierBody(idName, parentCallPath, ast, chunkCode, chunks, new Set(), 0, chunkId);
};

/**
 * Helper: rebuild the original astNodeToJsonString result, but for an Identifier-only
 * body, attempt to improve via taint trace.
 */
/**
 * Detects literal-undefined body arguments. Minified bundles emit `undefined` as
 * the `void 0` shorthand (UnaryExpression with operator `void` over any operand),
 * which axios treats as "no body". The bare identifier `undefined` is the same
 * thing in any non-shadowed scope. Either form should map to an empty body so
 * downstream consumers (openapi/postman) omit the request body entirely instead
 * of rendering the literal string `"void 0"`.
 */
const isUndefinedBodyNode = (node: Node): boolean => {
    if (!node) return false;
    if (node.type === "UnaryExpression" && (node as any).operator === "void") return true;
    if (node.type === "Identifier" && (node as any).name === "undefined") return true;
    return false;
};

export const resolveBodyArg = (
    bodyArgNode: Node,
    parentCallPath: NodePath,
    ast: Node,
    chunkCode: string,
    chunks: Chunks | undefined,
    chunkId?: string
): string => {
    if (isUndefinedBodyNode(bodyArgNode)) return "";
    if (bodyArgNode && bodyArgNode.type === "Identifier") {
        const traced = maybeTraceBodyForIdentifier(bodyArgNode, parentCallPath, ast, chunkCode, chunks, chunkId);
        if (traced) return traced;
    }
    return astNodeToJsonString(bodyArgNode, chunkCode);
};
