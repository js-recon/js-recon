import type { PookieGraph } from "@js-recon/taintwire";

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
 * compound `u += "/x"` loses its ordering and cycles are cut on revisit. taintwire has no
 * property/heap pass; `project()` covers what's local: destructuring, `o.k` of an object/array
 * literal (also returned from a function), and React hook summaries. Writes to a property
 * (`o.k = v`) stay unseen.
 */
export const makeResolver = (graph: PookieGraph) => {
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

    const inflow = async (id: string, rels = "FLOWS_TO|ARGUMENT_TO|RETURNS_TO"): Promise<string[]> =>
        (
            await query(`MATCH (src)-[:${rels}]->(n:\`${label(id)}\`) WHERE n.id = $id RETURN DISTINCT src.id AS id`, {
                id,
            })
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

    const parentOf = async (id: string): Promise<Row | undefined> =>
        (
            await query(
                `MATCH (p)-[s:SON]->(n:\`${label(id)}\`) WHERE n.id = $id RETURN p.id AS id, p.type AS type, s.key AS key, s.idx AS idx`,
                { id }
            )
        )[0];

    // A call's callee name: `f(...)`, `n.f(...)` or `(0, n.f)(...)`.
    const calleeName = async (call: string): Promise<string | undefined> => {
        let [c] = await kids(call, "callee");
        while (c && label(c) === "SequenceExpression") {
            const es = await kids(c, "expressions");
            c = es[es.length - 1];
        }
        if (!c) return undefined;
        if (label(c) === "Identifier") return (await row(c)).name;
        if (label(c) === "MemberExpression") {
            const [prop] = await kids(c, "property");
            return label(prop) === "Identifier" ? (await row(prop)).name : undefined;
        }
        return undefined;
    };

    // The expressions a function returns: a concise arrow body, or its body's top-level `return x`.
    // shortcut: returns nested in if/try blocks are missed; walk the function's own ReturnStatements if a hook needs it.
    const returned = async (fn: string): Promise<string[]> => {
        if (!/Function/.test(label(fn))) return [];
        const [body] = await kids(fn, "body");
        if (!body) return [];
        if (label(body) !== "BlockStatement") return [body];
        const out: string[] = [];
        for (const st of await kids(body, "body"))
            if (label(st) === "ReturnStatement") out.push(...(await kids(st, "argument")));
        return out;
    };

    const keyStep = async (member: string): Promise<string | number | undefined> => {
        const [prop] = await kids(member, "property");
        if (!prop) return undefined;
        const computed = (
            await query(`MATCH (m:MemberExpression) WHERE m.id = $id RETURN m.props AS p`, { id: member })
        )[0]?.p;
        const isComputed = typeof computed === "string" && computed.includes('"computed":true');
        const r = await row(prop);
        if (!isComputed) return label(prop) === "Identifier" ? r.name : undefined;
        if (label(prop) === "NumericLiteral") return Number(r.value);
        if (label(prop) === "StringLiteral") return String(r.value);
        return undefined;
    };

    /** Where a declared name sits in a destructuring pattern: the initializer and the path to it (`[a] = x` -> x, [0]). */
    const patternOf = async (decl: string): Promise<{ init: string; steps: (string | number)[] } | undefined> => {
        const steps: (string | number)[] = [];
        let node = decl;
        for (let i = 0; i < 12; i++) {
            const p = await parentOf(node);
            if (!p) return undefined;
            if (p.type === "ArrayPattern" && p.key === "elements") steps.unshift(Number(p.idx));
            else if (p.type === "ObjectProperty" && p.key === "value") {
                const [k] = await kids(p.id, "key");
                const r = k ? await row(k) : {};
                const name = r.name ?? r.value;
                if (name === undefined || name === null) return undefined;
                steps.unshift(String(name));
            } else if (p.type === "ObjectPattern" || (p.type === "AssignmentPattern" && p.key === "left")) {
                // keep climbing
            } else if (
                (p.type === "VariableDeclarator" && p.key === "id") ||
                (p.type === "AssignmentExpression" && p.key === "left")
            ) {
                const [init] = await kids(p.id, p.type === "VariableDeclarator" ? "init" : "right");
                return init && steps.length > 0 ? { init, steps } : undefined;
            } else return undefined;
            node = p.id;
        }
        return undefined;
    };

    // Values written through a useState setter: `[s, set] = useState(x)` / webpack's `d = l(useState(x), 2), set = d[1]`,
    // then `set(v)`. A functional update `set(prev => v)` counts with what it returns.
    const setterWrites = async (stateCall: string): Promise<string[]> => {
        const setters: string[] = [];
        const p = await parentOf(stateCall);
        if (p?.type === "VariableDeclarator" && p.key === "init") {
            const [pat] = await kids(p.id, "id");
            if (pat && label(pat) === "ArrayPattern") {
                const set = (await kids(pat, "elements"))[1];
                if (set) setters.push(set);
            }
        } else if (p?.type === "CallExpression" && p.key === "arguments" && Number(p.idx) === 0) {
            // slicedToArray(useState(x), n): `[1]` read off the helper's result or a binding it flows into
            for (const cypher of [
                `MATCH (m:MemberExpression)-[o:SON]->(h:CallExpression), (m)-[pk:SON]->(n:NumericLiteral) WHERE h.id = $id AND o.key = 'object' AND pk.key = 'property' RETURN m.id AS id, n.value AS v`,
                `MATCH (h:CallExpression)-[:FLOWS_TO* ACYCLIC 1..3]->(x)<-[o:SON]-(m:MemberExpression)-[pk:SON]->(n:NumericLiteral) WHERE h.id = $id AND o.key = 'object' AND pk.key = 'property' RETURN m.id AS id, n.value AS v`,
            ])
                for (const r of await query(cypher, { id: p.id })) if (String(r.v) === "1") setters.push(r.id);
        }
        if (setters.length === 0) return [];
        const out: string[] = [];
        const calls = await query(
            `MATCH (s)-[:FLOWS_TO* ACYCLIC 1..4]->(c0)<-[k:SON]-(c:CallExpression) WHERE s.id IN $ids AND k.key = 'callee' RETURN DISTINCT c.id AS id`,
            { ids: setters }
        );
        for (const { id } of calls) {
            const [a] = await kids(id, "arguments");
            if (!a) continue;
            for (const r of /Function/.test(label(a)) ? await returned(a) : [a]) out.push(...(await values(r)));
        }
        return out;
    };

    // useContext(ctx): the `value` of each `<ctx.Provider value>` (or React 19 `<ctx value>`) element the createContext()
    // result reaches, or createContext's default when there's none.
    const contextValues = async (ctxArg: string): Promise<string[]> => {
        const out: string[] = [];
        const makers = await query(
            `MATCH (c:CallExpression)-[:FLOWS_TO* ACYCLIC 1..8]->(a) WHERE a.id = $id RETURN DISTINCT c.id AS id`,
            {
                id: ctxArg,
            }
        );
        for (const { id: maker } of makers) {
            if ((await calleeName(maker)) !== "createContext") continue;
            const props = [
                ...(await query(
                    `MATCH (c:CallExpression)-[:FLOWS_TO* ACYCLIC 1..8]->(o)<-[ok:SON]-(m:MemberExpression)-[pk:SON]->(p:Identifier), (j:CallExpression)-[a0:SON]->(m), (j)-[a1:SON]->(props:ObjectExpression)
                     WHERE c.id = $id AND ok.key = 'object' AND pk.key = 'property' AND p.name = 'Provider' AND a0.key = 'arguments' AND a0.idx = 0 AND a1.key = 'arguments' AND a1.idx = 1
                     RETURN DISTINCT props.id AS id`,
                    { id: maker }
                )),
                ...(await query(
                    `MATCH (c:CallExpression)-[:FLOWS_TO* ACYCLIC 1..8]->(o), (j:CallExpression)-[a0:SON]->(o), (j)-[a1:SON]->(props:ObjectExpression)
                     WHERE c.id = $id AND a0.key = 'arguments' AND a0.idx = 0 AND a1.key = 'arguments' AND a1.idx = 1
                     RETURN DISTINCT props.id AS id`,
                    { id: maker }
                )),
            ];
            const before = out.length;
            for (const { id } of props) out.push(...(await project(id, ["value"])));
            if (out.length === before) {
                const [d] = await kids(maker, "arguments");
                if (d) out.push(...(await values(d)));
            }
        }
        return out;
    };

    // React hook summaries by callee name (no heap model needed): what the hook call itself evaluates to.
    // TODO(hooks): useReducer state after dispatch (reducer return values), useRef(x).current writes, useSyncExternalStore,
    // Vue ref(x).value / computed(() => x), and custom hooks that store the URL behind a heap object (`obj.url = x`)
    // need property flow (a heap model).
    const hookResult = async (call: string): Promise<string[] | undefined> => {
        const name = await calleeName(call);
        const args = await kids(call, "arguments");
        if (name === "useMemo" && args[0]) return returned(args[0]);
        if (name === "useDeferredValue" && args[0]) return [args[0]];
        return undefined;
    };

    const projecting = new Set<string>();
    /** Every string the `path` (object keys / array indexes) of `id`'s value may be, through patterns, literals and hooks. */
    const project = async (id: string, path: (string | number)[], depth = 0): Promise<string[]> => {
        if (path.length === 0) return values(id);
        const key = `${id}|${path.join("\0")}`;
        if (depth > 16 || projecting.has(key)) return [];
        projecting.add(key);
        try {
            const [step, ...rest] = path;
            const type = label(id);
            const each = async (ids: string[], p = path) => {
                const out: string[] = [];
                for (const x of ids) out.push(...(await project(x, p, depth + 1)));
                return uniq(out);
            };
            if (type === "ObjectExpression") {
                if (typeof step !== "string") return [];
                for (const prop of await kids(id, "properties")) {
                    if (label(prop) !== "ObjectProperty") continue;
                    const [k] = await kids(prop, "key");
                    const r = await row(k);
                    if (String(r.name ?? r.value) === step) return each(await kids(prop, "value"), rest);
                }
                return [];
            }
            if (type === "ArrayExpression") {
                const el = typeof step === "number" ? (await kids(id, "elements"))[step] : undefined;
                return el ? each([el], rest) : [];
            }
            if (type === "MemberExpression") {
                const s = await keyStep(id);
                return s === undefined ? [] : each(await kids(id, "object"), [s, ...path]);
            }
            if (type === "CallExpression") {
                const name = await calleeName(id);
                const args = await kids(id, "arguments");
                if (name === "useState" && step === 0 && args[0]) {
                    const init = /Function/.test(label(args[0])) ? await returned(args[0]) : [args[0]];
                    const out = await each(init, rest);
                    return uniq(rest.length === 0 ? [...out, ...(await setterWrites(id))] : out);
                }
                if (name === "useReducer" && step === 0 && args[1]) return each([args[1]], rest);
                if (name === "useRef" && step === "current" && args[0]) return each([args[0]], rest);
                // Babel's slicedToArray(x, n): x's own elements
                if (args.length === 2 && label(args[1]) === "NumericLiteral" && typeof step === "number")
                    return each([args[0]]);
                const hooked = await hookResult(id);
                if (hooked) return each(hooked);
                return each(await inflow(id, "RETURNS_TO"));
            }
            const sources = await inflow(id);
            if (sources.length > 0) return each(sources);
            if (type === "Identifier") {
                const pat = await patternOf(id);
                if (pat) return each([pat.init], [...pat.steps, ...path]);
            }
            return [];
        } finally {
            projecting.delete(key);
        }
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
        // `"/a/".concat(x)`: Babel/webpack output for template literals; ordered, so it's built
        // before the inflow union (taintwire >= 0.2 flows the receiver and arguments into the call).
        // A `concat` that resolves to a function of the app (RETURNS_TO) is that function's result instead.
        if (type === "CallExpression") {
            const hooked = await hookResult(id);
            if (hooked && hooked.length > 0) {
                const out: string[] = [];
                for (const h of hooked) out.push(...(await values(h)));
                return uniq(out);
            }
            if ((await calleeName(id)) === "useContext") {
                const ctx = await contextOf(id);
                if (ctx.length > 0) return ctx;
            }
            const [callee] = await kids(id, "callee");
            if (label(callee) === "MemberExpression") {
                const [prop] = await kids(callee, "property");
                if ((await row(prop)).name === "concat") {
                    const returned = await inflow(id, "RETURNS_TO");
                    if (returned.length > 0) {
                        const out: string[] = [];
                        for (const r of returned) out.push(...(await values(r)));
                        return uniq(out);
                    }
                    const [obj] = await kids(callee, "object");
                    const parts = [await values(obj)];
                    for (const a of await kids(id, "arguments")) parts.push(await values(a));
                    return cross(parts);
                }
            }
        }
        // `o.k` / `o[0]`: the key of whatever object or array (literal, pattern source, hook) `o` is
        if (type === "MemberExpression") {
            const step = await keyStep(id);
            const [obj] = await kids(id, "object");
            if (step !== undefined && obj) {
                const out = await project(obj, [step]);
                if (out.length > 0) return out;
            }
        }
        if (!STRUCTURAL.has(type)) {
            const sources = await inflow(id);
            if (sources.length > 0) {
                const out: string[] = [];
                for (const s of sources) out.push(...(await values(s)));
                return uniq(out);
            }
            // a name declared by destructuring: `[url] = useState(x)`, `{base} = useApi()`
            if (type === "Identifier") {
                const pat = await patternOf(id);
                if (pat) {
                    const out = await project(pat.init, pat.steps);
                    if (out.length > 0) return out;
                }
            }
        }
        return [await placeholder(id)];
    };

    const contextOf = async (call: string): Promise<string[]> => {
        const [a] = await kids(call, "arguments");
        return a ? contextValues(a) : [];
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
