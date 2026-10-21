import type { TaintGraph } from "@js-recon/taintwire";

// Variants kept per expression; any fan-out past this is dropped.
const MAX_VARIANTS = 16;

// Literals evaluate to their stored `value` column (template text is the cooked string).
const LITERALS = new Set(["StringLiteral", "NumericLiteral", "BooleanLiteral", "TemplateElement"]);

// Nodes whose value depends on the order of their AST children, so they are built from `SON`
// edges. Every other node takes the union of what flows into it (FLOWS_TO / ARGUMENT_TO /
// RETURNS_TO): identifiers, conditionals, `||`/`??`, assignments, returns, resolved calls.
const STRUCTURAL = new Set([
    ...LITERALS,
    "TemplateLiteral",
    "BinaryExpression",
    "MemberExpression",
    "ObjectExpression",
]);

type Row = Record<string, any>;

/** Node table name from a taintwire node id (`<type>_<hex>`), as taintwire's own `code()` does. */
const label = (id: string): string => id.slice(0, id.lastIndexOf("_"));

const uniq = (xs: string[]): string[] => [...new Set(xs)].slice(0, MAX_VARIANTS);

const cross = (parts: string[][]): string[] =>
    uniq(parts.reduce<string[]>((acc, p) => acc.flatMap((a) => p.map((b) => a + b)), [""]));

/**
 * Cypher-backed value resolver over one taintwire graph. Results are memoised per graph.
 *
 * ponytail: flow-insensitive (taintwire's FLOWS_TO summarises every write to a binding), so a
 * compound `u += "/x"` loses its ordering and cycles are cut on revisit; property reads
 * (`cfg.url`), destructuring and webpack-module exports stay placeholders because taintwire
 * 0.1.1 has no property/heap or module pass, and nothing flows across files.
 */
export const makeResolver = (graph: TaintGraph) => {
    /** graph.query, treating a node table that doesn't exist (no node of that AST type) as no rows. */
    const query = async (cypher: string, params?: Record<string, unknown>): Promise<Row[]> => {
        try {
            return await graph.query(cypher, params);
        } catch (e) {
            if (/does not exist/.test((e as Error).message)) return [];
            throw e;
        }
    };

    const rows = new Map<string, Row>();
    const row = async (id: string): Promise<Row> => {
        if (!rows.has(id)) {
            const [r] = await query(
                `MATCH (n:\`${label(id)}\`) WHERE n.id = $id RETURN n.name AS name, n.value AS value, n.operator AS operator`,
                { id }
            );
            rows.set(id, r ?? {});
        }
        return rows.get(id)!;
    };

    const sons = new Map<string, Row[]>();
    /** Child ids of `id` under the Babel field `key`, in array order. */
    const kids = async (id: string, key: string): Promise<string[]> => {
        if (!sons.has(id)) {
            sons.set(
                id,
                await query(
                    `MATCH (n:\`${label(id)}\`)-[s:SON]->(c) WHERE n.id = $id RETURN s.key AS key, s.idx AS idx, c.id AS id ORDER BY s.idx`,
                    { id }
                )
            );
        }
        return sons
            .get(id)!
            .filter((r) => r.key === key)
            .map((r) => r.id);
    };

    const inflow = async (id: string): Promise<string[]> =>
        (
            await query(
                `MATCH (src)-[:FLOWS_TO|ARGUMENT_TO|RETURNS_TO]->(n:\`${label(id)}\`) WHERE n.id = $id RETURN DISTINCT src.id AS id`,
                { id }
            )
        ).map((r) => r.id);

    // Placeholders use the legacy formats, so replaceUrlPlaceholders turns them into OpenAPI params.
    const placeholder = async (id: string): Promise<string> => {
        const type = label(id);
        if (type === "Identifier") return `[var ${(await row(id)).name}]`;
        if (type === "MemberExpression") return `[MemberExpression -> ${await graph.code(id)}]`;
        if (type === "CallExpression" || type === "NewExpression") {
            const callee = await graph.code((await kids(id, "callee"))[0]);
            return `[call:${type === "NewExpression" ? "new " : ""}${callee}()]`;
        }
        return `[call:${await graph.code(id)}]`;
    };

    const memo = new Map<string, string[]>();
    const onPath = new Set<string>();

    /** Every string `id` may evaluate to (capped at MAX_VARIANTS). */
    const values = async (id: string): Promise<string[]> => {
        if (memo.has(id)) return memo.get(id)!;
        if (onPath.has(id)) return [];
        onPath.add(id);
        try {
            const out = await evaluate(id);
            memo.set(id, out);
            return out;
        } finally {
            onPath.delete(id);
        }
    };

    const evaluate = async (id: string): Promise<string[]> => {
        const type = label(id);
        if (LITERALS.has(type)) return [String((await row(id)).value ?? "")];
        if (type === "NullLiteral") return [""];
        if (type === "TemplateLiteral") {
            const quasis = await kids(id, "quasis");
            const exprs = await kids(id, "expressions");
            const parts: string[][] = [];
            for (let i = 0; i < quasis.length; i++) {
                parts.push(await values(quasis[i]));
                if (exprs[i]) parts.push(await values(exprs[i]));
            }
            return cross(parts);
        }
        if (type === "BinaryExpression" && (await row(id)).operator === "+") {
            const [left] = await kids(id, "left");
            const [right] = await kids(id, "right");
            return cross([await values(left), await values(right)]);
        }
        if (!STRUCTURAL.has(type)) {
            const sources = await inflow(id);
            if (sources.length > 0) {
                const out: string[] = [];
                for (const s of sources) out.push(...(await values(s)));
                return uniq(out);
            }
        }
        // `"/a/".concat(x)`: Babel/webpack output for template literals; unresolved as a call.
        if (type === "CallExpression") {
            const [callee] = await kids(id, "callee");
            if (label(callee) === "MemberExpression") {
                const [prop] = await kids(callee, "property");
                if ((await row(prop)).name === "concat") {
                    const [obj] = await kids(callee, "object");
                    const parts = [await values(obj)];
                    for (const a of await kids(id, "arguments")) parts.push(await values(a));
                    return cross(parts);
                }
            }
        }
        return [await placeholder(id)];
    };

    /**
     * A JSON-ish rendering of `id`: an object literal (directly or the one that flows into it, or
     * the argument of `JSON.stringify(...)`) becomes `{key: rendered}`, anything else its first value.
     */
    const render = async (id: string, seen = new Set<string>()): Promise<unknown> => {
        if (seen.has(id)) return "";
        seen.add(id);
        const type = label(id);
        if (type === "ObjectExpression") {
            const out: Record<string, unknown> = {};
            for (const p of await kids(id, "properties")) {
                if (label(p) !== "ObjectProperty") continue;
                const [k] = await kids(p, "key");
                const [v] = await kids(p, "value");
                const key = await row(k);
                out[String(key.name ?? key.value)] = await render(v, seen);
            }
            return out;
        }
        if (type === "CallExpression") {
            const [callee] = await kids(id, "callee");
            const [arg] = await kids(id, "arguments");
            if (arg && (await graph.code(callee)) === "JSON.stringify") return render(arg, seen);
        }
        if (!STRUCTURAL.has(type)) {
            for (const s of await inflow(id)) {
                const r = await render(s, seen);
                if (r !== null && typeof r === "object") return r;
            }
        }
        return (await values(id))[0] ?? "";
    };

    return { query, kids, values, render };
};
