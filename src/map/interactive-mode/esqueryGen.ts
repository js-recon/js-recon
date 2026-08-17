import chalk from "chalk";
import * as parser from "@babel/parser";
import traverse from "@babel/traverse";
import generator from "@babel/generator";
import { Node } from "@babel/types";
import { Chunks } from "../../utility/interfaces.js";

/**
 * Escape a string so it can be safely embedded inside a double-quoted
 * esquery attribute value.
 */
function escapeAttr(value: string): string {
    return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Build an esquery selector from a Babel AST node. The selector aims to be
 * specific enough to match the original node while still being readable so
 * the user can broaden or trim it when authoring a rule.
 */
function generateSelector(node: Node): string {
    switch (node.type) {
        case "Identifier":
            return `Identifier[name="${escapeAttr((node as any).name)}"]`;
        case "StringLiteral":
            return `StringLiteral[value="${escapeAttr((node as any).value)}"]`;
        case "NumericLiteral":
            return `NumericLiteral[value=${(node as any).value}]`;
        case "BooleanLiteral":
            return `BooleanLiteral[value=${(node as any).value}]`;
        case "RegExpLiteral":
            return `RegExpLiteral[pattern="${escapeAttr((node as any).pattern)}"]`;
        case "TemplateLiteral":
            return "TemplateLiteral";
        case "MemberExpression": {
            const me = node as any;
            const parts: string[] = ["MemberExpression"];
            if (me.object?.type === "Identifier") {
                parts.push(`[object.name="${escapeAttr(me.object.name)}"]`);
            } else {
                parts.push(`[object.type="${me.object?.type}"]`);
            }
            if (me.property?.type === "Identifier") {
                parts.push(`[property.name="${escapeAttr(me.property.name)}"]`);
            } else if (me.property?.type === "StringLiteral") {
                parts.push(`[property.value="${escapeAttr(me.property.value)}"]`);
            }
            return parts.join("");
        }
        case "CallExpression":
        case "NewExpression": {
            const ce = node as any;
            const parts: string[] = [node.type];
            const callee = ce.callee;
            if (callee?.type === "Identifier") {
                parts.push(`[callee.name="${escapeAttr(callee.name)}"]`);
            } else if (callee?.type === "MemberExpression") {
                parts.push(`[callee.type="MemberExpression"]`);
                if (callee.object?.type === "Identifier") {
                    parts.push(`[callee.object.name="${escapeAttr(callee.object.name)}"]`);
                }
                if (callee.property?.type === "Identifier") {
                    parts.push(`[callee.property.name="${escapeAttr(callee.property.name)}"]`);
                }
            } else if (callee?.type) {
                parts.push(`[callee.type="${callee.type}"]`);
            }
            return parts.join("");
        }
        case "AssignmentExpression": {
            const ae = node as any;
            return `AssignmentExpression[operator="${escapeAttr(ae.operator)}"]`;
        }
        case "BinaryExpression":
        case "LogicalExpression": {
            const be = node as any;
            return `${node.type}[operator="${escapeAttr(be.operator)}"]`;
        }
        case "ObjectProperty": {
            const op = node as any;
            if (op.key?.type === "Identifier") {
                return `${node.type}[key.name="${escapeAttr(op.key.name)}"]`;
            }
            if (op.key?.type === "StringLiteral") {
                return `${node.type}[key.value="${escapeAttr(op.key.value)}"]`;
            }
            return node.type;
        }
        case "FunctionDeclaration":
        case "FunctionExpression":
        case "ArrowFunctionExpression": {
            const fd = node as any;
            if (fd.id?.name) {
                return `${node.type}[id.name="${escapeAttr(fd.id.name)}"]`;
            }
            return node.type;
        }
        case "VariableDeclarator": {
            const vd = node as any;
            if (vd.id?.type === "Identifier") {
                return `VariableDeclarator[id.name="${escapeAttr(vd.id.name)}"]`;
            }
            return "VariableDeclarator";
        }
        case "JSXIdentifier":
            return `JSXIdentifier[name="${escapeAttr((node as any).name)}"]`;
        case "JSXAttribute": {
            const ja = node as any;
            if (ja.name?.type === "JSXIdentifier") {
                return `JSXAttribute[name.name="${escapeAttr(ja.name.name)}"]`;
            }
            return "JSXAttribute";
        }
        default:
            return node.type;
    }
}

/**
 * Generate a tighter esquery selector that pins the immediate children of
 * the matched node by type. Useful when the user wants to detect this exact
 * shape (e.g. fetch(`/api/...${x}`)) rather than any fetch().
 */
function generateStrictSelector(node: Node): string {
    const base = generateSelector(node);
    const extras: string[] = [];
    switch (node.type) {
        case "CallExpression":
        case "NewExpression": {
            const ce = node as any;
            const args = ce.arguments || [];
            extras.push(`[arguments.length=${args.length}]`);
            args.forEach((arg: any, i: number) => {
                if (arg?.type) extras.push(`[arguments.${i}.type="${escapeAttr(arg.type)}"]`);
            });
            break;
        }
        case "AssignmentExpression": {
            const ae = node as any;
            if (ae.left?.type) extras.push(`[left.type="${escapeAttr(ae.left.type)}"]`);
            if (ae.right?.type) extras.push(`[right.type="${escapeAttr(ae.right.type)}"]`);
            if (ae.left?.type === "MemberExpression" && ae.left.property?.type === "Identifier") {
                extras.push(`[left.property.name="${escapeAttr(ae.left.property.name)}"]`);
            }
            break;
        }
        case "BinaryExpression":
        case "LogicalExpression": {
            const be = node as any;
            if (be.left?.type) extras.push(`[left.type="${escapeAttr(be.left.type)}"]`);
            if (be.right?.type) extras.push(`[right.type="${escapeAttr(be.right.type)}"]`);
            break;
        }
        case "ObjectProperty": {
            const op = node as any;
            if (op.value?.type) extras.push(`[value.type="${escapeAttr(op.value.type)}"]`);
            break;
        }
        case "MemberExpression": {
            const me = node as any;
            if (me.computed !== undefined) extras.push(`[computed=${me.computed ? "true" : "false"}]`);
            break;
        }
        case "VariableDeclarator": {
            const vd = node as any;
            if (vd.init?.type) extras.push(`[init.type="${escapeAttr(vd.init.type)}"]`);
            break;
        }
    }
    return base + extras.join("");
}

/**
 * Reformat code so it matches regardless of whitespace, indentation, or
 * comments. We parse it and re-emit it via @babel/generator in compact mode;
 * if parsing fails (e.g. a fragment that can't stand alone) we fall back to a
 * simple whitespace-collapse.
 */
function normalizeCode(code: string): string {
    const trimmed = code.trim();
    if (trimmed.length === 0) return "";
    const attempts = [
        () => parser.parse(trimmed, { sourceType: "unambiguous", plugins: ["jsx", "typescript"], errorRecovery: true }),
        // Fragments like `fetch(x)` parse fine as a Program — but isolated
        // expressions like `{a: 1}` parse as a Block. Wrap as an expression
        // statement to coerce parsing in that case.
        () =>
            parser.parse(`(${trimmed})`, {
                sourceType: "unambiguous",
                plugins: ["jsx", "typescript"],
                errorRecovery: true,
            }),
    ];
    for (const attempt of attempts) {
        try {
            const ast = attempt();
            // Prefer emitting just the inner expression when the source is a single
            // expression-statement program (e.g. `fetch(x)` or `a.b.c`) — the
            // statement-level generator appends a trailing `;` that AST nodes
            // generated standalone never carry, which prevents substring matches.
            const program = (ast as any).program;
            let target: any = ast;
            if (
                program &&
                Array.isArray(program.body) &&
                program.body.length === 1 &&
                program.body[0].type === "ExpressionStatement"
            ) {
                target = program.body[0].expression;
            }
            const out = generator(target, { compact: true, comments: false }).code;
            return out
                .replace(/^\(|\);?$/g, "")
                .replace(/;+$/g, "")
                .trim();
        } catch {
            // try next strategy
        }
    }
    // last-resort fallback: collapse whitespace
    return trimmed.replace(/\s+/g, "");
}

interface Candidate {
    index: number;
    type: string;
    line: number;
    column: number;
    chunkId: string;
    snippet: string;
    selector: string;
    strictSelector: string;
}

/**
 * Parse the chunk and collect AST nodes whose normalized (minified) source
 * contains the normalized search term. Returns up to `limit` candidates.
 */
function findCandidates(code: string, search: string, limit: number, chunkId: string): Candidate[] {
    let ast: any;
    try {
        ast = parser.parse(code, {
            sourceType: "unambiguous",
            plugins: ["jsx", "typescript"],
            errorRecovery: true,
        });
    } catch (e) {
        return [];
    }

    const needle = normalizeCode(search);
    if (needle.length === 0) return [];

    type RawMatch = { node: Node; start: number; end: number; normalized: string };
    const raw: RawMatch[] = [];

    traverse(ast, {
        enter(path: any) {
            const node: Node = path.node;
            const start = (node as any).start;
            const end = (node as any).end;
            if (typeof start !== "number" || typeof end !== "number") return;

            // Re-emit the node compact so the comparison is independent of the
            // chunk's whitespace/comments/formatting.
            let nodeNormalized: string;
            try {
                nodeNormalized = generator(node, { compact: true, comments: false }).code;
            } catch {
                return;
            }
            if (nodeNormalized.indexOf(needle) === -1) return;

            raw.push({ node, start, end, normalized: nodeNormalized });
        },
    });

    // Keep only minimal matches: drop any match that strictly contains another match.
    // (Ancestors of a real match always also match the substring, but they're noise.)
    const minimal: RawMatch[] = raw.filter((m) => {
        for (const other of raw) {
            if (other === m) continue;
            if (other.start >= m.start && other.end <= m.end && (other.start > m.start || other.end < m.end)) {
                return false;
            }
        }
        return true;
    });

    const candidates: Candidate[] = [];
    for (const m of minimal) {
        if (candidates.length >= limit) break;
        const node = m.node;
        const snippet = m.normalized.length > 120 ? m.normalized.slice(0, 117) + "..." : m.normalized;
        candidates.push({
            index: candidates.length,
            type: node.type,
            line: node.loc?.start.line ?? 0,
            column: node.loc?.start.column ?? 0,
            chunkId,
            snippet,
            selector: generateSelector(node),
            strictSelector: generateStrictSelector(node),
        });
    }

    // Dedupe candidates that share the exact same strict selector + snippet.
    const seen = new Set<string>();
    const deduped: Candidate[] = [];
    for (const c of candidates) {
        const key = `${c.strictSelector}|${c.snippet}`;
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push({ ...c, index: deduped.length });
    }
    return deduped;
}

/**
 * Public entry point used by the interactive command handler.
 *
 * `chunkId` may be a specific chunk key or `*` / `all` to scan every chunk.
 * `search` is normalized (minified via babel) before being matched against
 * each AST node's also-normalized source, so the user can paste a snippet
 * verbatim from prettified source and still hit a node inside a minified
 * production chunk.
 *
 * Returns a formatted, colorised string ready to be logged.
 */
function runEsqueryCommand(chunks: Chunks, chunkId: string, search: string): string {
    if (!search || search.length === 0) {
        return chalk.red("Search term is required");
    }

    const scanAll = chunkId === "*" || chunkId.toLowerCase() === "all";
    const targets: { id: string; code: string }[] = [];
    if (scanAll) {
        for (const [id, ch] of Object.entries(chunks)) {
            targets.push({ id, code: (ch as any).code });
        }
    } else {
        const chunk = chunks[chunkId];
        if (!chunk) return chalk.red(`Chunk ${chunkId} not found`);
        targets.push({ id: chunkId, code: chunk.code });
    }

    const limitPerChunk = scanAll ? 5 : 25;
    const all: Candidate[] = [];
    for (const t of targets) {
        const hits = findCandidates(t.code, search, limitPerChunk, t.id);
        for (const c of hits) all.push(c);
        if (all.length >= 200) break;
    }

    if (all.length === 0) {
        return chalk.yellow(
            `No AST nodes in ${scanAll ? `${targets.length} chunk(s)` : `chunk ${chunkId}`} matched the snippet`
        );
    }

    // re-index for display
    all.forEach((c, i) => (c.index = i));

    let out = chalk.cyan(
        `Found ${all.length} candidate node(s) ${scanAll ? `across ${targets.length} chunk(s)` : `in chunk ${chunkId}`} matching the (normalized) snippet:\n`
    );
    for (const c of all) {
        out += chalk.green(`\n[${c.index}] `) + chalk.bold(c.type);
        out += chalk.gray(` (chunk ${c.chunkId}, line ${c.line}:${c.column})`);
        out += `\n  ${chalk.gray("snippet:")}  ${c.snippet}`;
        out += `\n  ${chalk.gray("loose:")}    ${chalk.yellow(c.selector)}`;
        out += `\n  ${chalk.gray("strict:")}   ${chalk.yellow(c.strictSelector)}\n`;
    }
    out += chalk.gray(
        "\nTip: paste the loose selector into a rule's `esquery.query` and refine; use strict to check whether an exact node is already covered."
    );
    return out;
}

export { runEsqueryCommand, generateSelector, generateStrictSelector, findCandidates, normalizeCode };
