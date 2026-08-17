import traverse from "@babel/traverse";
import * as parser from "@babel/parser";
import execFunc from "../../utility/runSandboxed.js";

/**
 * Pure parser: extracts `[chunkId, chunkName]` entries from webpack's
 * FunctionExpression object-map pattern:
 *   function(e) { return ({123: "name", ...}[e] || e) + ".js"; }
 * Returns entries from the first qualifying object map (≥ 3 numeric-keyed string entries).
 */
export const extractObjectMapChunkEntries = (jsContent: string): Array<[number, string]> => {
    const result: Array<[number, string]> = [];
    let ast: any;
    try {
        ast = parser.parse(jsContent, {
            sourceType: "unambiguous",
            plugins: ["jsx", "typescript"],
            errorRecovery: true,
        });
    } catch {
        return result;
    }

    traverse(ast, {
        FunctionExpression(path) {
            const start = path.node.start ?? 0;
            const end = path.node.end ?? jsContent.length;
            const source = jsContent.slice(start, end);
            if (!source.match(/\|\|\s*e/) || !source.includes('".js"')) return;

            path.traverse({
                ObjectExpression(objPath) {
                    const props = objPath.node.properties;
                    if (props.length < 3) return;

                    const entries: Array<[number, string]> = [];
                    for (const prop of props) {
                        if (prop.type !== "ObjectProperty") continue;
                        const key = prop.key;
                        const value = prop.value;
                        if (value.type !== "StringLiteral") continue;

                        let keyNum: number | null = null;
                        if (key.type === "NumericLiteral") keyNum = key.value;
                        else if (key.type === "StringLiteral" && /^\d+$/.test(key.value)) keyNum = parseInt(key.value);
                        else if (key.type === "Identifier" && /^\d+$/.test(key.name)) keyNum = parseInt(key.name);

                        if (keyNum === null) continue;
                        entries.push([keyNum, value.value]);
                    }

                    if (entries.length >= 3) {
                        result.push(...entries);
                        objPath.stop();
                        path.stop();
                    }
                },
            });
        },
    });

    return result;
};

/**
 * Pure parser: extracts chunk filenames from webpack's ArrowFunctionExpression
 * if-chain pattern:
 *   (e) => { if (123 === e) return "name.js"; if (456 === e) return "other.js"; ... }
 * Returns filenames only when there are at least 3 qualifying if-statements.
 */
export const extractIfChainChunkFilenames = (jsContent: string): string[] => {
    const result: string[] = [];
    let ast: any;
    try {
        ast = parser.parse(jsContent, {
            sourceType: "unambiguous",
            plugins: ["jsx", "typescript"],
            errorRecovery: true,
        });
    } catch {
        return result;
    }

    traverse(ast, {
        ArrowFunctionExpression(path) {
            const body = path.node.body;
            if (body.type !== "BlockStatement") return;

            // skip expression-body arrows (handled by extractExpressionBodyChunkFilenames)
            const start = path.node.start ?? 0;
            const end = path.node.end ?? jsContent.length;
            const source = jsContent.slice(start, end);
            if (source.match(/"\.js".{0,15}$/)) return;

            const filenames: string[] = [];
            for (const stmt of body.body) {
                if (stmt.type !== "IfStatement") continue;
                const test = stmt.test;
                if (test.type !== "BinaryExpression" || test.operator !== "===") continue;
                const { left, right } = test;
                const isNumericEqParam =
                    (left.type === "NumericLiteral" && right.type === "Identifier") ||
                    (right.type === "NumericLiteral" && left.type === "Identifier");
                if (!isNumericEqParam) continue;
                const consequent = stmt.consequent;
                if (consequent.type !== "ReturnStatement" || !consequent.argument) continue;
                const arg = consequent.argument;
                if (arg.type !== "StringLiteral" || !arg.value.endsWith(".js")) continue;
                filenames.push(arg.value);
            }

            if (filenames.length >= 3) result.push(...filenames);
        },
    });

    return result;
};

/**
 * Pure parser: extracts chunk filenames from webpack's ArrowFunctionExpression
 * expression-body pattern (e.g. `(e) => (HASHMAP[e] || e) + ".js"`) by executing the
 * arrow in a sandbox for every integer literal referenced in its own source — the
 * hash-map values aren't visible to plain string extraction because they're only
 * produced by evaluating the expression.
 */
export const extractExpressionBodyChunkFilenames = (jsContent: string): string[] => {
    const result: string[] = [];
    let ast: any;
    try {
        ast = parser.parse(jsContent, {
            sourceType: "unambiguous",
            plugins: ["jsx", "typescript"],
            errorRecovery: true,
        });
    } catch {
        return result;
    }

    traverse(ast, {
        ArrowFunctionExpression(path) {
            const start = path.node.start ?? 0;
            const end = path.node.end ?? jsContent.length;
            const source = jsContent.slice(start, end);

            if (!source.match(/"\.js".{0,15}$/)) return;

            const urlBuilderFunc = `(() => (${source}))()`;
            const integers = source.match(/\d+/g);
            if (!integers) return;

            for (const i of integers) {
                try {
                    const output = execFunc(urlBuilderFunc, parseInt(i));
                    if (typeof output === "string" && !output.includes("undefined")) {
                        result.push(output);
                    }
                } catch {
                    // skip integers that cause errors in sandboxed execution
                }
            }
        },
    });

    return result;
};

/**
 * Pure parser: extracts full chunk paths from webpack's string-keyed ("named chunk ids")
 * object-map pattern, seen when `optimization.chunkIds` isn't forced to `"deterministic"`
 * numeric ids (webpack 5's dev-mode default, and this pattern's own `output.chunkFilename`
 * uses `[name]` rather than a bare hash):
 *   (chunkId) => { return "assets/" + chunkId + "." + {"name1":"hash1",...}[chunkId] + ".js"; }
 * Unlike `extractObjectMapChunkEntries`'s numeric-keyed pattern, here the object's keys ARE
 * the chunk names (no separate id→name lookup needed) and there's no `|| chunkId` fallback
 * arm, so the whole literal path is reconstructed per-entry by walking the flattened `+`
 * concatenation chain and substituting the map lookup with each entry's hash and every
 * bare-identifier reference to the function's own parameter with that entry's key.
 * Returns entries only from a map with ≥ 3 non-numeric string-keyed string-valued
 * properties (numeric-keyed maps are `extractObjectMapChunkEntries`'s territory).
 */
export const extractStringKeyedChunkMap = (jsContent: string, fileUrl: string): string[] => {
    const result: string[] = [];
    let ast: any;
    try {
        ast = parser.parse(jsContent, {
            sourceType: "unambiguous",
            plugins: ["jsx", "typescript"],
            errorRecovery: true,
        });
    } catch {
        return result;
    }

    const visitFn = (path: any) => {
        const params = path.node.params;
        if (params.length !== 1 || params[0].type !== "Identifier") return;
        const paramName = params[0].name;

        let returnArg: any = null;
        if (path.node.body.type === "BlockStatement") {
            for (const stmt of path.node.body.body) {
                if (stmt.type === "ReturnStatement" && stmt.argument) {
                    returnArg = stmt.argument;
                    break;
                }
            }
        } else {
            returnArg = path.node.body;
        }
        if (!returnArg) return;

        // Flatten a left-associative "+"-concatenation chain into an ordered token list.
        const parts: any[] = [];
        const flatten = (node: any) => {
            if (node.type === "BinaryExpression" && node.operator === "+") {
                flatten(node.left);
                flatten(node.right);
            } else {
                parts.push(node);
            }
        };
        flatten(returnArg);

        const mapNode = parts.find(
            (p) =>
                p.type === "MemberExpression" &&
                p.computed &&
                p.property.type === "Identifier" &&
                p.property.name === paramName &&
                p.object.type === "ObjectExpression"
        );
        if (!mapNode) return;

        const entries: Array<[string, string]> = [];
        for (const prop of mapNode.object.properties) {
            if (prop.type !== "ObjectProperty") continue;
            const key = prop.key;
            const value = prop.value;
            if (value.type !== "StringLiteral") continue;
            let keyStr: string | null = null;
            if (key.type === "StringLiteral") keyStr = key.value;
            else if (key.type === "Identifier") keyStr = key.name;
            if (keyStr === null || /^\d+$/.test(keyStr)) continue;
            entries.push([keyStr, value.value]);
        }
        if (entries.length < 3) return;

        for (const [name, hash] of entries) {
            let output = "";
            let ok = true;
            for (const p of parts) {
                if (p.type === "StringLiteral") output += p.value;
                else if (p.type === "Identifier" && p.name === paramName) output += name;
                else if (p === mapNode) output += hash;
                else {
                    ok = false;
                    break;
                }
            }
            if (ok) {
                const resolved = resolveChunkUrl(output, fileUrl);
                if (resolved) result.push(resolved);
            }
        }
    };

    traverse(ast, {
        ArrowFunctionExpression: visitFn,
        FunctionExpression: visitFn,
    });

    return result;
};

/**
 * Resolves a raw chunk filename against the file it was found in. Webpack commonly
 * emits chunk names one directory up from the entry chunk that references them, so a
 * bare filename (no scheme, no leading "/", "./", or "../") is resolved against "../"
 * relative to fileUrl; anything already absolute or explicitly relative is resolved
 * as-is.
 */
const resolveChunkUrl = (output: string, fileUrl: string): string | null => {
    try {
        const normalized =
            output.startsWith("/") || output.startsWith("http") || output.startsWith("./") || output.startsWith("../")
                ? output
                : "../" + output;
        return new URL(normalized, fileUrl).href;
    } catch {
        return null;
    }
};

/**
 * Runs all three webpack chunk-path-builder patterns (object-map, if-chain,
 * expression-body) against one file's content and returns every resolved chunk URL.
 * Shared between the React crawler (`react_webpackChunkPaths.ts`) and `generic` tech's
 * structural discovery (`generic_webpackChunkPaths.ts`, internal#75) — these are plain
 * webpack output patterns, not React-specific, so a webpack/module-federation entry
 * chunk's own async-chunk hash-map can be statically enumerated regardless of which
 * tech branch downloaded it.
 */
export const extractWebpackChunkUrls = (jsContent: string, fileUrl: string): string[] => {
    const urls = new Set<string>();

    for (const [, chunkName] of extractObjectMapChunkEntries(jsContent)) {
        const resolved = resolveChunkUrl(`${chunkName}.js`, fileUrl);
        if (resolved) urls.add(resolved);
    }

    for (const filename of extractIfChainChunkFilenames(jsContent)) {
        const resolved = resolveChunkUrl(filename, fileUrl);
        if (resolved) urls.add(resolved);
    }

    for (const filename of extractExpressionBodyChunkFilenames(jsContent)) {
        const resolved = resolveChunkUrl(filename, fileUrl);
        if (resolved) urls.add(resolved);
    }

    for (const resolved of extractStringKeyedChunkMap(jsContent, fileUrl)) {
        urls.add(resolved);
    }

    return [...urls];
};
