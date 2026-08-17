/**
 * Cross-file marker resolver for Vite/webpack-chunk-style bundles.
 *
 * Each chunk wraps modules in:
 *   (self.webpackChunkX = self.webpackChunkX || []).push([
 *     [chunkId],
 *     {
 *       moduleId(q, M, e) {
 *         e.r(M);                                  // mark ES module
 *         e.d(M, { name: () => binding, ... });    // getter exports
 *         const k = e(N);                          // import chunk N
 *         const binding = ...                      // local
 *       }
 *     }
 *   ])
 */
import fs from "fs";
import path from "path";
import * as parser from "@babel/parser";
import traverse from "@babel/traverse";

interface WebpackModule {
    moduleId: string;
    bodyBlock: any;
    requireParam: string | null;
    exportsParam: string | null;
    exports: Map<string, string>;
    locals: Map<string, any>;
    imports: Map<string, string>;
    filePath: string;
}

interface ParsedChunkFile {
    modules: Map<string, WebpackModule>;
}

const chunkFileCache = new Map<string, ParsedChunkFile | null>();
let globalModuleIndex: Map<string, WebpackModule> | null = null;
let globalIndexBuiltFor: string | null = null;

const isRequireCall = (node: any, requireParam: string | null): { moduleId: string } | null => {
    if (!node || node.type !== "CallExpression") return null;
    if (!requireParam) return null;
    if (node.callee.type !== "Identifier" || node.callee.name !== requireParam) return null;
    if (node.arguments.length !== 1) return null;
    const arg = node.arguments[0];
    if (arg.type === "NumericLiteral") return { moduleId: String(arg.value) };
    if (arg.type === "StringLiteral") return { moduleId: arg.value };
    return null;
};

const literalNodeToString = (node: any): string | null => {
    if (!node) return null;
    if (node.type === "StringLiteral") return node.value;
    if (node.type === "NumericLiteral") return String(node.value);
    if (node.type === "BooleanLiteral") return String(node.value);
    if (node.type === "NullLiteral") return "null";
    if (node.type === "TemplateLiteral" && node.expressions.length === 0 && node.quasis.length === 1) {
        return node.quasis[0].value.cooked ?? node.quasis[0].value.raw ?? null;
    }
    return null;
};

const parseChunkFile = (filePath: string): ParsedChunkFile | null => {
    if (chunkFileCache.has(filePath)) return chunkFileCache.get(filePath) ?? null;
    let content: string;
    try {
        content = fs.readFileSync(filePath, "utf-8");
    } catch {
        chunkFileCache.set(filePath, null);
        return null;
    }
    let ast: any;
    try {
        ast = parser.parse(content, {
            sourceType: "unambiguous",
            plugins: ["jsx", "typescript"],
            errorRecovery: true,
        });
    } catch {
        chunkFileCache.set(filePath, null);
        return null;
    }

    const modules = new Map<string, WebpackModule>();

    traverse(ast, {
        CallExpression(p: any) {
            const callee = p.node.callee;
            if (callee.type !== "MemberExpression") return;
            if (callee.property.type !== "Identifier" || callee.property.name !== "push") return;
            if (p.node.arguments.length !== 1) return;
            const arr = p.node.arguments[0];
            if (arr.type !== "ArrayExpression") return;
            if (arr.elements.length < 2) return;
            const payload = arr.elements[1];
            if (!payload || payload.type !== "ObjectExpression") return;

            for (const prop of payload.properties) {
                if (prop.type !== "ObjectProperty" && prop.type !== "ObjectMethod") continue;
                const key = prop.key;
                let moduleId: string | null = null;
                if (key.type === "Identifier") moduleId = key.name;
                else if (key.type === "NumericLiteral") moduleId = String(key.value);
                else if (key.type === "StringLiteral") moduleId = key.value;
                if (!moduleId) continue;

                const fnNode = prop.type === "ObjectMethod" ? prop : prop.value;
                if (!fnNode) continue;
                const params =
                    fnNode.type === "ObjectMethod"
                        ? fnNode.params
                        : fnNode.type === "FunctionExpression" || fnNode.type === "ArrowFunctionExpression"
                          ? fnNode.params
                          : null;
                const body =
                    fnNode.type === "ObjectMethod"
                        ? fnNode.body
                        : fnNode.type === "FunctionExpression" || fnNode.type === "ArrowFunctionExpression"
                          ? fnNode.body
                          : null;
                if (!params || !body) continue;

                const requireParam = params[2]?.type === "Identifier" ? params[2].name : null;
                const exportsParam = params[1]?.type === "Identifier" ? params[1].name : null;

                const exports_ = new Map<string, string>();
                const locals = new Map<string, any>();
                const imports = new Map<string, string>();

                if (body.type === "BlockStatement") {
                    for (const stmt of body.body) {
                        if (stmt.type === "ExpressionStatement") {
                            const ex = stmt.expression;
                            if (
                                ex.type === "CallExpression" &&
                                ex.callee.type === "MemberExpression" &&
                                ex.callee.object.type === "Identifier" &&
                                requireParam &&
                                ex.callee.object.name === requireParam &&
                                ex.callee.property.type === "Identifier" &&
                                ex.callee.property.name === "d" &&
                                ex.arguments.length === 2 &&
                                ex.arguments[1]?.type === "ObjectExpression"
                            ) {
                                for (const ep of ex.arguments[1].properties) {
                                    if (ep.type !== "ObjectProperty") continue;
                                    const k =
                                        ep.key.type === "Identifier"
                                            ? ep.key.name
                                            : ep.key.type === "StringLiteral"
                                              ? ep.key.value
                                              : null;
                                    if (!k) continue;
                                    const v = ep.value;
                                    if (v.type === "ArrowFunctionExpression" && v.body.type === "Identifier") {
                                        exports_.set(k, v.body.name);
                                    } else if (v.type === "FunctionExpression" && v.body.type === "BlockStatement") {
                                        for (let i = v.body.body.length - 1; i >= 0; i--) {
                                            const s = v.body.body[i];
                                            if (s.type === "ReturnStatement" && s.argument?.type === "Identifier") {
                                                exports_.set(k, s.argument.name);
                                                break;
                                            }
                                        }
                                    }
                                }
                            }
                        }
                        if (stmt.type === "VariableDeclaration") {
                            for (const d of stmt.declarations) {
                                if (d.id.type !== "Identifier" || !d.init) continue;
                                const name = d.id.name;
                                locals.set(name, d.init);
                                const reqCall = isRequireCall(d.init, requireParam);
                                if (reqCall) imports.set(name, reqCall.moduleId);
                            }
                        }
                        if (stmt.type === "FunctionDeclaration" && stmt.id) {
                            locals.set(stmt.id.name, stmt);
                        }
                    }
                }

                modules.set(moduleId, {
                    moduleId,
                    bodyBlock: body,
                    requireParam,
                    exportsParam,
                    exports: exports_,
                    locals,
                    imports,
                    filePath,
                });
            }
        },
    });

    const parsed: ParsedChunkFile = { modules };
    chunkFileCache.set(filePath, parsed);
    return parsed;
};

const ensureGlobalIndex = (directory: string): void => {
    if (globalIndexBuiltFor === directory && globalModuleIndex) return;
    globalModuleIndex = new Map<string, WebpackModule>();
    let files: string[];
    try {
        files = fs.readdirSync(directory, { recursive: true, encoding: "utf8" }) as string[];
    } catch {
        globalIndexBuiltFor = directory;
        return;
    }
    files = files.filter((f) => f.endsWith(".js") || f.endsWith(".mjs"));
    for (const rel of files) {
        const abs = path.join(directory, rel);
        try {
            if (!fs.lstatSync(abs).isFile()) continue;
        } catch {
            continue;
        }
        const parsed = parseChunkFile(abs);
        if (!parsed) continue;
        for (const [modId, mod] of parsed.modules) {
            if (!globalModuleIndex.has(modId)) globalModuleIndex.set(modId, mod);
        }
    }
    globalIndexBuiltFor = directory;
};

const findModuleContainingFile = (filePath: string): WebpackModule | null => {
    const parsed = parseChunkFile(filePath);
    if (!parsed || parsed.modules.size === 0) return null;
    let best: WebpackModule | null = null;
    let bestSize = -1;
    for (const mod of parsed.modules.values()) {
        const size = mod.bodyBlock?.body?.length ?? 0;
        if (size > bestSize) {
            best = mod;
            bestSize = size;
        }
    }
    return best;
};

const walkObjectMember = (node: any, propPath: string[]): any | null => {
    let cur = node;
    for (const prop of propPath) {
        if (!cur) return null;
        if (cur.type !== "ObjectExpression") return null;
        let found: any = null;
        for (const p of cur.properties ?? []) {
            if (p.type !== "ObjectProperty") continue;
            const k = p.key.type === "Identifier" ? p.key.name : p.key.type === "StringLiteral" ? p.key.value : null;
            if (k === prop) {
                found = p.value;
                break;
            }
        }
        if (!found) return null;
        cur = found;
    }
    return cur;
};

export const crossFileResolveMember = (
    identName: string,
    propPath: string[],
    fromFilePath: string,
    directory: string,
    depth = 0,
    visited: Set<string> = new Set()
): string | null => {
    if (depth > 5) return null;
    ensureGlobalIndex(directory);
    if (!globalModuleIndex) return null;

    const visitKey = `${fromFilePath}::${identName}::${propPath.join(".")}`;
    if (visited.has(visitKey)) return null;
    visited.add(visitKey);

    const mod = findModuleContainingFile(fromFilePath);
    if (!mod) return null;

    const localInit = mod.locals.get(identName);
    if (localInit) {
        const target = walkObjectMember(localInit, propPath);
        const lit = literalNodeToString(target);
        if (lit !== null) return lit;
        if (target?.type === "Identifier") {
            return crossFileResolveMember(target.name, [], fromFilePath, directory, depth + 1, visited);
        }
    }

    const targetModuleId = mod.imports.get(identName);
    if (!targetModuleId) return null;
    const targetMod = globalModuleIndex.get(targetModuleId);
    if (!targetMod) return null;

    if (propPath.length === 0) return null;
    const exportName = propPath[0];
    const restPath = propPath.slice(1);
    const localBindingName = targetMod.exports.get(exportName);
    if (!localBindingName) return null;
    const bindingInit = targetMod.locals.get(localBindingName);
    if (!bindingInit) return null;

    const target = walkObjectMember(bindingInit, restPath);
    const lit = literalNodeToString(target);
    if (lit !== null) return lit;
    if (target?.type === "Identifier") {
        return crossFileResolveMember(target.name, [], targetMod.filePath, directory, depth + 1, visited);
    }

    return null;
};

const inlineFunctionReturn = (fnNode: any): string | null => {
    if (!fnNode) return null;
    const body =
        fnNode.type === "FunctionDeclaration" ||
        fnNode.type === "FunctionExpression" ||
        fnNode.type === "ArrowFunctionExpression" ||
        fnNode.type === "ObjectMethod"
            ? fnNode.body
            : null;
    if (!body) return null;
    if (body.type !== "BlockStatement") {
        return literalNodeToString(body);
    }
    for (let i = body.body.length - 1; i >= 0; i--) {
        const s = body.body[i];
        if (s.type === "ReturnStatement" && s.argument) {
            const lit = literalNodeToString(s.argument);
            if (lit !== null) return lit;
        }
    }
    return null;
};

export const crossFileResolveCallReturn = (
    chain: string[],
    fromFilePath: string,
    directory: string,
    depth = 0,
    visited: Set<string> = new Set()
): string | null => {
    if (chain.length === 0 || depth > 5) return null;
    ensureGlobalIndex(directory);
    if (!globalModuleIndex) return null;

    const visitKey = `${fromFilePath}::call::${chain.join(".")}`;
    if (visited.has(visitKey)) return null;
    visited.add(visitKey);

    const mod = findModuleContainingFile(fromFilePath);
    if (!mod) return null;

    const root = chain[0];

    const localInit = mod.locals.get(root);
    if (localInit) {
        let cur = localInit;
        if (chain.length === 1) return inlineFunctionReturn(cur);
        cur = walkObjectMember(cur, chain.slice(1));
        if (!cur) return null;
        if (cur.type === "Identifier") {
            return crossFileResolveCallReturn([cur.name], fromFilePath, directory, depth + 1, visited);
        }
        return inlineFunctionReturn(cur);
    }

    const targetModuleId = mod.imports.get(root);
    if (!targetModuleId) return null;
    const targetMod = globalModuleIndex.get(targetModuleId);
    if (!targetMod) return null;

    if (chain.length === 1) return null;
    const exportName = chain[1];
    const restPath = chain.slice(2);
    const localBindingName = targetMod.exports.get(exportName);
    if (!localBindingName) return null;
    const bindingInit = targetMod.locals.get(localBindingName);
    if (!bindingInit) return null;

    if (restPath.length === 0) return inlineFunctionReturn(bindingInit);
    const target = walkObjectMember(bindingInit, restPath);
    if (!target) return null;
    if (target.type === "Identifier") {
        return crossFileResolveCallReturn([target.name], targetMod.filePath, directory, depth + 1, visited);
    }
    return inlineFunctionReturn(target);
};

export const substituteCrossFileMarkers = (input: string, fromFilePath: string, directory: string): string => {
    if (typeof input !== "string" || !input) return input;
    let out = input;
    out = out.replace(/\[member:([A-Za-z_$][\w$.]*)\]/g, (match, chain: string) => {
        const parts = chain.split(".");
        if (parts.length < 2) return match;
        const resolved = crossFileResolveMember(parts[0], parts.slice(1), fromFilePath, directory);
        return resolved ?? match;
    });
    out = out.replace(/\[call:([A-Za-z_$][\w$.]*)\(\)\]/g, (match, chain: string) => {
        const parts = chain.split(".");
        const resolved = crossFileResolveCallReturn(parts, fromFilePath, directory);
        return resolved ?? match;
    });
    return out;
};

export const substituteCrossFileMarkersDeep = (value: any, fromFilePath: string, directory: string): any => {
    if (value === null || value === undefined) return value;
    if (typeof value === "string") return substituteCrossFileMarkers(value, fromFilePath, directory);
    if (Array.isArray(value)) return value.map((v) => substituteCrossFileMarkersDeep(v, fromFilePath, directory));
    if (typeof value === "object") {
        const o: Record<string, any> = {};
        for (const [k, v] of Object.entries(value)) {
            const nk = typeof k === "string" ? substituteCrossFileMarkers(k, fromFilePath, directory) : k;
            o[nk] = substituteCrossFileMarkersDeep(v, fromFilePath, directory);
        }
        return o;
    }
    return value;
};
