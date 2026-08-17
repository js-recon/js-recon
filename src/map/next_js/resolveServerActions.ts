import * as parser from "@babel/parser";
import traverse from "@babel/traverse";
import path from "path";
import { Chunks } from "../../utility/interfaces.js";
import * as globals from "../../utility/globals.js";
import { printMsg, MSG } from "../../utility/printMsg.js";

/**
 * Derives the Next.js App Router page route from a chunk file path.
 *
 * File paths from Next.js static chunks look like:
 *   _next/static/chunks/app/page-HASH.js                          → /
 *   _next/static/chunks/app/products/page-HASH.js                 → /products
 *   _next/static/chunks/app/products/list/detail/page-HASH.js    → /products/list/detail
 *
 * Route group segments like "(marketing)" are stripped.
 * Dynamic segments like [id] are converted to {id} for OpenAPI compatibility.
 */
const deriveRouteFromFile = (filePath: string): string | null => {
    const normalized = filePath.replace(/\\/g, "/");
    const match = normalized.match(/(?:_next\/static\/chunks\/)?app\/(.+)/);
    if (!match) return null;

    const relPath = match[1];
    const segments = relPath.split("/");
    segments.pop();

    const routeSegments = segments.filter((seg) => !(seg.startsWith("(") && seg.endsWith(")")));
    if (routeSegments.length === 0) return "/";

    const processedSegments = routeSegments.map((seg) => {
        if (seg.startsWith("[[...") && seg.endsWith("]]")) return `{${seg.slice(5, -2)}}`;
        if (seg.startsWith("[...") && seg.endsWith("]")) return `{${seg.slice(4, -1)}}`;
        if (seg.startsWith("[") && seg.endsWith("]")) return `{${seg.slice(1, -1)}}`;
        return seg;
    });

    return "/" + processedSegments.join("/");
};

/**
 * Returns true when the node is a createServerReference invocation.
 *
 *   (0, X.createServerReference)(actionId, ...)   — sequence expression
 *   X.createServerReference(actionId, ...)        — direct member call
 */
const isCreateServerReferenceCall = (node: any): boolean => {
    const callee = node.callee;
    if (
        callee.type === "MemberExpression" &&
        callee.property.type === "Identifier" &&
        callee.property.name === "createServerReference"
    ) {
        return true;
    }
    if (callee.type === "SequenceExpression" && callee.expressions.length === 2) {
        const second = callee.expressions[1];
        if (
            second.type === "MemberExpression" &&
            second.property.type === "Identifier" &&
            second.property.name === "createServerReference"
        ) {
            return true;
        }
    }
    return false;
};

/**
 * Extracts a human-readable hint from a call-site argument AST node.
 *
 * Literals are returned verbatim.  For dynamic expressions the most meaningful
 * identifier or property name is used, e.g.:
 *   a.userId        → "<string:userId>"
 *   t.getName()     → "<string:getName>"
 *   firstName + lastName → "<string:firstName+lastName>"
 *   e.get("key")    → "<string:key>"
 *   cond ? x : y   → first non-placeholder branch
 */
// Extracts just the variable name portion from a hint that may already carry
// a <type:name> prefix (e.g. "<string:userId>" → "userId", "someValue" → "someValue").
const hintName = (hint: string): string => {
    const typed = /^<[^:>]+:(.+)>$/.exec(hint);
    if (typed) return typed[1];
    if (hint.startsWith("<") && hint.endsWith(">")) return hint.slice(1, -1);
    return hint;
};

const getArgHint = (node: any): string => {
    if (!node) return "<string:arg>";
    switch (node.type) {
        case "StringLiteral":
            return node.value;
        case "NumericLiteral":
            return String(node.value);
        case "BooleanLiteral":
            return String(node.value);
        case "NullLiteral":
            return "null";

        case "Identifier":
            return `<string:${node.name}>`;

        case "MemberExpression": {
            const prop = node.property;
            const name = prop.type === "Identifier" ? prop.name : prop.type === "StringLiteral" ? prop.value : null;
            return name ? `<string:${name}>` : "<string:member>";
        }

        case "CallExpression": {
            const { callee, arguments: callArgs } = node;
            if (callee.type === "MemberExpression") {
                const methodName = callee.property.type === "Identifier" ? callee.property.name : null;
                // e.get("key") → <string:key>
                if (methodName === "get" && callArgs.length > 0 && callArgs[0].type === "StringLiteral") {
                    return `<string:${callArgs[0].value}>`;
                }
                // No-arg method calls: prefer a meaningful method name over the object name,
                // except for trivial converters like toString/valueOf.
                if (callArgs.length === 0) {
                    if (methodName && methodName !== "toString" && methodName !== "valueOf") {
                        return `<string:${methodName}>`;
                    }
                    return getArgHint(callee.object);
                }
                return methodName ? `<string:${methodName}>` : "<string:call>";
            }
            if (callee.type === "Identifier") return `<string:${callee.name}>`;
            return "<string:call>";
        }

        case "BinaryExpression": {
            if (node.operator === "+") {
                const l = getArgHint(node.left);
                const r = getArgHint(node.right);
                const lname = hintName(l);
                const rname = hintName(r);
                if (!lname) return `<string:${rname}>`;
                if (!rname) return `<string:${lname}>`;
                return `<string:${lname}+${rname}>`;
            }
            return "<number>";
        }

        case "LogicalExpression": {
            // a || b — prefer a non-empty literal on the right, otherwise recurse left
            const { left, right } = node;
            if (right.type === "StringLiteral" && right.value) return right.value;
            return getArgHint(left);
        }

        case "ConditionalExpression": {
            const c = getArgHint(node.consequent);
            if (!c.startsWith("<")) return c;
            const a = getArgHint(node.alternate);
            if (!a.startsWith("<")) return a;
            return c;
        }

        case "AwaitExpression":
            return getArgHint(node.argument);

        case "AssignmentExpression":
            return getArgHint(node.right);

        case "TemplateLiteral":
            return "<string:template>";

        default:
            return "<string:value>";
    }
};

/**
 * Returns the variable name assigned from a createServerReference call by
 * walking up to the VariableDeclarator parent.
 */
const getAssignedVarName = (nodePath: any): string | null => {
    const parent = nodePath.parentPath;
    if (parent?.isVariableDeclarator() && parent.node.id?.type === "Identifier") {
        return parent.node.id.name;
    }
    return null;
};

/**
 * Looks for n.d(t, { exportName: () => varName }) patterns and returns the
 * export name for the specified variable, or null.
 */
const findExportNameForVar = (ast: any, varName: string): string | null => {
    let exportName: string | null = null;
    traverse(ast, {
        CallExpression(p: any) {
            if (exportName) return;
            const callee = p.node.callee;
            if (
                callee.type === "MemberExpression" &&
                callee.property.type === "Identifier" &&
                callee.property.name === "d" &&
                p.node.arguments.length >= 2
            ) {
                const second = p.node.arguments[1];
                if (second.type !== "ObjectExpression") return;
                for (const prop of second.properties) {
                    if (prop.type !== "ObjectProperty") continue;
                    const value = prop.value;
                    if (
                        value.type === "ArrowFunctionExpression" &&
                        value.body.type === "Identifier" &&
                        value.body.name === varName
                    ) {
                        exportName =
                            prop.key.type === "Identifier"
                                ? prop.key.name
                                : prop.key.type === "StringLiteral"
                                  ? prop.key.value
                                  : null;
                        if (exportName) p.stop();
                        return;
                    }
                }
            }
        },
    });
    return exportName;
};

interface CallSiteResult {
    args: any[];
    line: number;
    chunkId: string;
    absFile: string;
}

/**
 * Searches a chunk's AST for direct calls to a named variable:
 *   varName(...)  or  (0, varName)(...)
 */
const findInChunkCallArgs = (ast: any, varName: string, chunkId: string, absFile: string): CallSiteResult | null => {
    let foundArgs: any[] | null = null;
    let foundLine = 0;
    traverse(ast, {
        CallExpression(p: any) {
            if (foundArgs) return;
            const callee = p.node.callee;
            if (callee.type === "Identifier" && callee.name === varName) {
                foundArgs = p.node.arguments;
                foundLine = p.node.loc?.start.line ?? 0;
                p.stop();
                return;
            }
            if (
                callee.type === "SequenceExpression" &&
                callee.expressions.length === 2 &&
                callee.expressions[1].type === "Identifier" &&
                callee.expressions[1].name === varName
            ) {
                foundArgs = p.node.arguments;
                foundLine = p.node.loc?.start.line ?? 0;
                p.stop();
            }
        },
    });
    if (!foundArgs) return null;
    return { args: foundArgs, line: foundLine, chunkId, absFile };
};

/**
 * Searches chunks that import chunkId for calls to exportName:
 *   moduleVar.exportName(...)  or  (0, moduleVar.exportName)(...)
 */
const findCrossChunkCallArgs = (
    chunkId: string,
    exportName: string,
    chunks: Chunks,
    directory: string
): CallSiteResult | null => {
    for (const [callerId, callerChunk] of Object.entries(chunks)) {
        if (!callerChunk.imports.includes(chunkId)) continue;
        if (!callerChunk.code.includes(exportName)) continue;

        let callerAst: any;
        try {
            callerAst = parser.parse(callerChunk.code, {
                sourceType: "module",
                plugins: ["jsx", "typescript"],
                errorRecovery: true,
            });
        } catch {
            continue;
        }

        let foundArgs: any[] | null = null;
        let foundLine = 0;
        traverse(callerAst, {
            CallExpression(p: any) {
                if (foundArgs) return;
                const callee = p.node.callee;
                if (
                    callee.type === "MemberExpression" &&
                    callee.property.type === "Identifier" &&
                    callee.property.name === exportName
                ) {
                    foundArgs = p.node.arguments;
                    foundLine = p.node.loc?.start.line ?? 0;
                    p.stop();
                    return;
                }
                if (callee.type === "SequenceExpression" && callee.expressions.length === 2) {
                    const second = callee.expressions[1];
                    if (
                        second.type === "MemberExpression" &&
                        second.property.type === "Identifier" &&
                        second.property.name === exportName
                    ) {
                        foundArgs = p.node.arguments;
                        foundLine = p.node.loc?.start.line ?? 0;
                        p.stop();
                    }
                }
            },
        });

        if (foundArgs) {
            return {
                args: foundArgs,
                line: foundLine,
                chunkId: callerId,
                absFile: path.resolve(directory, callerChunk.file),
            };
        }
    }
    return null;
};

interface ServerActionEntry {
    actionId: string;
    actionName: string | undefined;
    varName: string | null;
    line: number;
}

/**
 * Scans all chunks for Next.js Server Action registrations and records each
 * discovered action in the global OpenAPI output.
 *
 * For each action:
 *  - The route is derived from the chunk's App Router file path, or resolved
 *    via one level of the importer graph for shared/lazy chunks.
 *  - Arguments are traced from the first call site found in the same chunk or
 *    in importer chunks via the exported symbol.  Each argument is reduced to
 *    a named hint (e.g. "<string:userId>", "<string:token>") using identifier/property
 *    names from the call-site AST.
 *  - Definition and call-site locations (chunk ID + absolute file path + line)
 *    are recorded for reference.
 */
const resolveServerActions = async (chunks: Chunks, directory: string): Promise<void> => {
    printMsg(MSG.Header, "[i] Resolving Next.js Server Actions");

    const importedBy = new Map<string, Set<string>>();
    for (const [id, chunk] of Object.entries(chunks)) {
        for (const dep of chunk.imports || []) {
            if (!importedBy.has(dep)) importedBy.set(dep, new Set());
            importedBy.get(dep)!.add(id);
        }
    }

    const seenActionIds = new Set<string>();

    for (const chunk of Object.values(chunks)) {
        if (!chunk.code || !chunk.file) continue;
        if (!chunk.code.includes("createServerReference")) continue;

        let route = deriveRouteFromFile(chunk.file);
        if (!route) {
            const importers = importedBy.get(chunk.id) ?? new Set<string>();
            for (const importerId of importers) {
                const importerRoute = deriveRouteFromFile(chunks[importerId]?.file ?? "");
                if (importerRoute) {
                    route = importerRoute;
                    break;
                }
            }
        }
        if (!route) route = "/";

        let ast: any;
        try {
            ast = parser.parse(chunk.code, {
                sourceType: "module",
                plugins: ["jsx", "typescript"],
                errorRecovery: true,
            });
        } catch {
            continue;
        }

        const defAbsFile = path.resolve(directory, chunk.file);

        // First pass: collect all server action definitions in this chunk.
        const entries: ServerActionEntry[] = [];
        traverse(ast, {
            CallExpression(nodePath: any) {
                if (!isCreateServerReferenceCall(nodePath.node)) return;

                const args = nodePath.node.arguments;
                if (args.length < 1) return;

                const firstArg = args[0];
                if (firstArg.type !== "StringLiteral") return;

                const actionId: string = firstArg.value;
                if (!/^[0-9a-f]{40,}$/i.test(actionId)) return;
                if (seenActionIds.has(actionId)) return;
                seenActionIds.add(actionId);

                let actionName: string | undefined;
                if (args.length >= 5 && args[4].type === "StringLiteral") {
                    actionName = args[4].value;
                }

                entries.push({
                    actionId,
                    actionName,
                    varName: getAssignedVarName(nodePath),
                    line: nodePath.node.loc?.start.line ?? 0,
                });
            },
        });

        // Second pass: trace call sites and build the request body for each action.
        for (const entry of entries) {
            let callSite: CallSiteResult | null = null;

            if (entry.varName) {
                callSite = findInChunkCallArgs(ast, entry.varName, chunk.id, defAbsFile);

                if (!callSite) {
                    const exportName = findExportNameForVar(ast, entry.varName);
                    if (exportName) {
                        callSite = findCrossChunkCallArgs(chunk.id, exportName, chunks, directory);
                    }
                }
            }

            let body = "";
            if (callSite && callSite.args.length > 0) {
                const hints = callSite.args.map(getArgHint);
                body = JSON.stringify(hints);
                printMsg(MSG.Header, `    [i] Args for '${entry.actionName || entry.actionId}': ${body}`);
            }

            const logLabel = entry.actionName ? `${entry.actionName} (${entry.actionId})` : entry.actionId;
            printMsg(MSG.Info, `[+] Server Action '${logLabel}' at route '${route}' (chunk ${chunk.id})`);

            globals.addOpenapiOutput({
                url: route,
                method: "POST",
                path: route,
                headers: {
                    Accept: "text/x-component",
                    "next-action": entry.actionId,
                    "Content-Type": "text/plain;charset=UTF-8",
                },
                body,
                chunkId: chunk.id,
                functionFile: defAbsFile,
                functionFileLine: entry.line,
                summary: entry.actionName,
                serverActionCallChunkId: callSite?.chunkId,
                serverActionCallFile: callSite?.absFile,
                serverActionCallLine: callSite?.line,
            });
        }
    }
};

export default resolveServerActions;
