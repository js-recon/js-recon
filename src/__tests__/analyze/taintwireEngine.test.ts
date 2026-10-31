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

const chunks = (code: string): Chunks => ({ m1: { id: "m1", code } as Chunks[string] });

const TWO_OPAQUE_STEPS = `const p = new URLSearchParams(location.search), t = p.get("q"); document.body.innerHTML = t;`;

describe("taintwire analyze engine", { timeout: 60000 }, () => {
    it("deep mode follows a value through two opaque calls", async () => {
        const findings = await taintwireEngine([rule()], chunks(TWO_OPAQUE_STEPS));
        expect(findings).toHaveLength(1);
        expect(findings[0].ruleType).toBe("taintwire");
        expect(findings[0].findingLocation).toMatch(/^\/\/ m1:1:\d+ <- m1:1:\d+ \(\d+ hops\)/);
    });

    it("strict and lenient modes stop at the opaque calls", async () => {
        expect(await taintwireEngine([rule({ mode: "strict" })], chunks(TWO_OPAQUE_STEPS))).toHaveLength(0);
        expect(await taintwireEngine([rule({ mode: "lenient" })], chunks(TWO_OPAQUE_STEPS))).toHaveLength(0);
    });

    it("lenient mode widens through one wrapper", async () => {
        const code = `document.body.innerHTML = location.hash.slice(1);`;
        expect(await taintwireEngine([rule({ mode: "lenient" })], chunks(code))).toHaveLength(1);
    });

    it("does not fire without a flow, and maxHops drops long flows", async () => {
        expect(
            await taintwireEngine([rule()], chunks(`const q = location.search; document.body.innerHTML = other;`))
        ).toHaveLength(0);
        expect(await taintwireEngine([rule({ maxHops: 0 })], chunks(TWO_OPAQUE_STEPS))).toHaveLength(0);
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
        expect(await taintwireEngine([msg], chunks(code))).toHaveLength(1);
    });

    it("skips chunks no prefilter matches", async () => {
        expect(await taintwireEngine([rule({}, "nomatch")], chunks(TWO_OPAQUE_STEPS))).toHaveLength(0);
    });

    it("schema rejects step names that can't be Cypher parameters", () => {
        const bad = { ...rule(), steps: [{ name: "bad-name", message: "m", taintwire: { query: URL_SOURCE } }] };
        expect(ruleSchema.safeParse(rule()).success).toBe(true);
        expect(ruleSchema.safeParse(bad).success).toBe(false);
        expect(ruleSchema.safeParse({ ...rule(), prefilter: "(" }).success).toBe(false);
    });
});
