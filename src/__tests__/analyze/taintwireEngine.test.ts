import { describe, it, expect } from "vitest";
import taintwireEngine from "../../analyze/engine/taintwireEngine.js";
import { Rule, TaintwireStep } from "../../analyze/types/index.js";
import { Chunks } from "../../utility/interfaces.js";
import { ruleSchema } from "../../analyze/helpers/schemas.js";

const URL_SOURCE = `MATCH (n:MemberExpression)-[:SON {key: 'property'}]->(p:Identifier), (n)-[:SON {key: 'object'}]->(o)
WHERE p.name IN ['hash', 'search'] AND o.name = 'location'
RETURN n.id AS id, n.file AS file, n.line AS line, n.col AS col`;
const HTML_SINK = `MATCH (a:AssignmentExpression)-[:SON {key: 'left'}]->(:MemberExpression)-[:SON {key: 'property'}]->(p:Identifier), (a)-[:SON {key: 'right'}]->(n)
WHERE p.name = 'innerHTML' AND NOT n.type IN ['StringLiteral', 'NumericLiteral', 'NullLiteral', 'BooleanLiteral']
RETURN n.id AS id, n.file AS file, n.line AS line, n.col AS col`;
const HANDLERS = `MATCH (c:CallExpression)-[:SON {key: 'callee'}]->(:MemberExpression)-[:SON {key: 'property'}]->(ae:Identifier),
      (c)-[a0:SON {key: 'arguments'}]->(t:StringLiteral), (c)-[a1:SON {key: 'arguments'}]->(h)
WHERE ae.name = 'addEventListener' AND a0.idx = 0 AND a1.idx = 1 AND t.value = 'message' AND h.type IN ['FunctionExpression', 'ArrowFunctionExpression']
RETURN h.id AS id, h.file AS file, h.line AS line, h.col AS col`;
const MESSAGE_DATA = `MATCH (f)-[:SON {key: 'params', idx: 0}]->(d:Identifier)<-[:REFERS_TO]-(e:Identifier)<-[:SON {key: 'object'}]-(n:MemberExpression)-[:SON {key: 'property'}]->(p:Identifier)
WHERE f.id IN $listener AND p.name = 'data'
RETURN n.id AS id, n.file AS file, n.line AS line, n.col AS col`;
const EVAL_SINK = `MATCH (c:CallExpression)-[:SON {key: 'callee'}]->(f:Identifier), (c)-[a:SON {key: 'arguments'}]->(n)
WHERE f.name = 'eval' AND a.idx = 0
RETURN n.id AS id, n.file AS file, n.line AS line, n.col AS col`;

const rule = (sink: Partial<TaintwireStep> = {}, prefilter?: string): Rule => ({
    id: "t",
    name: "url to innerHTML",
    author: "test",
    description: "test",
    js_recon_version: ">=0.0.0",
    tech: ["all"],
    severity: "high",
    type: "taintwire",
    prefilter,
    steps: [
        { name: "source", message: "source", taintwire: { query: URL_SOURCE } },
        { name: "sink", message: "sink", taintwire: { query: [HTML_SINK], taintFrom: "source", ...sink } },
    ],
});

const findingsOf = async (rules: Rule[], c: Chunks) => (await taintwireEngine(rules, c)).findings;

const chunks = (code: string): Chunks => ({ m1: { id: "m1", code } as Chunks[string] });

const TWO_OPAQUE_STEPS = `const p = new URLSearchParams(location.search), t = p.get("q"); document.body.innerHTML = t;`;

describe("taintwire analyze engine", { timeout: 60000 }, () => {
    it("deep mode follows a value through two opaque calls", async () => {
        const findings = await findingsOf([rule()], chunks(TWO_OPAQUE_STEPS));
        expect(findings).toHaveLength(1);
        expect(findings[0].ruleType).toBe("taintwire");
        expect(findings[0].message).toBe("sink"); // the rule's own message, not the console line
        expect(findings[0].findingLocation).toMatch(/^\/\/ m1:1:\d+ <- m1:1:\d+ \(\d+ hops\)/);
    });

    it("strict and lenient modes stop at the opaque calls", async () => {
        expect(await findingsOf([rule({ mode: "strict" })], chunks(TWO_OPAQUE_STEPS))).toHaveLength(0);
        expect(await findingsOf([rule({ mode: "lenient" })], chunks(TWO_OPAQUE_STEPS))).toHaveLength(0);
    });

    it("lenient mode widens through one wrapper", async () => {
        const code = `document.body.innerHTML = location.hash.slice(1);`;
        expect(await findingsOf([rule({ mode: "lenient" })], chunks(code))).toHaveLength(1);
    });

    it("does not fire without a flow, and maxHops drops long flows", async () => {
        expect(
            await findingsOf([rule()], chunks(`const q = location.search; document.body.innerHTML = other;`))
        ).toHaveLength(0);
        expect(await findingsOf([rule({ maxHops: 0 })], chunks(TWO_OPAQUE_STEPS))).toHaveLength(0);
    });

    it("passes earlier step ids as Cypher parameters", async () => {
        const msg: Rule = {
            ...rule(),
            steps: [
                { name: "listener", message: "listener", taintwire: { query: HANDLERS } },
                { name: "data", message: "data", taintwire: { query: MESSAGE_DATA } },
                { name: "sink", message: "sink", taintwire: { query: EVAL_SINK, taintFrom: "data" } },
            ],
        };
        const code = `function run(x) { eval(x); } window.addEventListener("message", (e) => run(e.data.expr));`;
        expect(await findingsOf([msg], chunks(code))).toHaveLength(1);
    });

    it("skips chunks no prefilter matches", async () => {
        expect(await findingsOf([rule({}, "nomatch")], chunks(TWO_OPAQUE_STEPS))).toHaveLength(0);
    });

    it("a requires naming no earlier step leaves the rule without findings", async () => {
        const withRequires = (requires: string[]): Rule => {
            const r = rule();
            r.steps[1] = { ...r.steps[1], requires };
            return r;
        };
        expect(await findingsOf([withRequires(["source"])], chunks(TWO_OPAQUE_STEPS))).toHaveLength(1);
        expect(await findingsOf([withRequires(["missing"])], chunks(TWO_OPAQUE_STEPS))).toHaveLength(0);
        // an Object.prototype member is not a step
        expect(await findingsOf([withRequires(["toString"])], chunks(TWO_OPAQUE_STEPS))).toHaveLength(0);
    });

    it("skips a chunk too big to load into a graph", async () => {
        const big = TWO_OPAQUE_STEPS + "/*" + "x".repeat(8 * 1024 * 1024) + "*/";
        expect(await findingsOf([rule()], chunks(big))).toHaveLength(0);
    });

    it("reports a rule whose query fails, and still runs the others", async () => {
        const broken: Rule = {
            ...rule(),
            id: "broken",
            steps: [{ name: "sink", message: "sink", taintwire: { query: "MATCH (n RETURN n.id AS id" } }],
        };
        const run = await taintwireEngine([broken, rule()], chunks(TWO_OPAQUE_STEPS));
        expect(run.failedRules).toEqual(["broken"]);
        expect(run.findings).toHaveLength(1);
    });

    it("schema accepts maxHops 0 and rejects a taintFrom that names no earlier step", () => {
        expect(ruleSchema.safeParse(rule({ maxHops: 0 })).success).toBe(true);
        expect(ruleSchema.safeParse(rule({ taintFrom: "missing" })).success).toBe(false);
        const later = rule();
        later.steps = [
            { name: "sink", message: "sink", taintwire: { query: HTML_SINK, taintFrom: "source" } },
            { name: "source", message: "source", taintwire: { query: URL_SOURCE } },
        ];
        expect(ruleSchema.safeParse(later).success).toBe(false);
    });

    it("schema rejects step names that can't be Cypher parameters", () => {
        const proto = { ...rule(), steps: [{ name: "__proto__", message: "m", taintwire: { query: URL_SOURCE } }] };
        expect(ruleSchema.safeParse(proto).success).toBe(false);
        const bad = { ...rule(), steps: [{ name: "bad-name", message: "m", taintwire: { query: URL_SOURCE } }] };
        expect(ruleSchema.safeParse(rule()).success).toBe(true);
        expect(ruleSchema.safeParse(bad).success).toBe(false);
        expect(ruleSchema.safeParse({ ...rule(), prefilter: "(" }).success).toBe(false);
    });
});
