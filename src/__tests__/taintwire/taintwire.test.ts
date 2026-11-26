import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import * as tar from "tar";
import { build, analyze, validate } from "../../taintwire/index.js";

const AT = "n.file AS file, n.line AS line, n.col AS col";
const LIB = `import type { PGSelector } from "@js-recon/taintwire";
export const hashRead: PGSelector = { cypher: { query: \`MATCH (n:MemberExpression)-[:SON {key: 'property'}]->(p:Identifier), (n)-[:SON {key: 'object'}]->(o)
WHERE p.name = 'hash' AND o.name = 'location' RETURN n.id AS id, p.name AS kind, ${AT}\` } };`;
const RULE = `import type { PGRule } from "@js-recon/taintwire";
import { hashRead } from "./lib.pgq";
export default {
    id: "hash_html", name: "Hash to innerHTML", severity: "high", message: "location.hash reaches innerHTML",
    return: [{ from: hashRead, cypher: { query: \`MATCH (a:AssignmentExpression)-[:SON {key: 'left'}]->(:MemberExpression)-[:SON {key: 'property'}]->(p:Identifier), (a)-[:SON {key: 'right'}]->(n)
WHERE p.name = 'innerHTML' RETURN n.id AS id, ${AT}\` } }],
} satisfies PGRule;`;

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "jsr-tw-"));
const exits = () =>
    vi.spyOn(process, "exit").mockImplementation(((code: number) => {
        throw new Error(`exit ${code}`);
    }) as never);

afterEach(() => vi.restoreAllMocks());

describe("taintwire build / analyze / validate", { timeout: 120000 }, () => {
    it("builds a linked PookieGraph and finds a flow across two files", async () => {
        const dir = tmp();
        const js = path.join(dir, "js");
        const q = path.join(dir, "q");
        fs.mkdirSync(js);
        fs.mkdirSync(q);
        fs.writeFileSync(path.join(js, "a.js"), "const h = location.hash; document.body.innerHTML = h;");
        fs.writeFileSync(path.join(js, "b.js"), "console.log(1);");
        fs.writeFileSync(path.join(q, "lib.pgq"), LIB);
        fs.writeFileSync(path.join(q, "rule.pgq"), RULE);
        const pg = path.join(dir, "app.pg");
        const out = path.join(dir, "out.sarif");
        const outs = { json: path.join(dir, "out.json"), sarif: out };
        try {
            await build(js, pg);
            expect(fs.existsSync(pg)).toBe(true);
            await analyze(pg, q, outs);
            const sarif = JSON.parse(fs.readFileSync(out, "utf-8"));
            expect(sarif.version).toBe("2.1.0");
            expect(sarif.runs[0].tool.driver.rules.map((r: { id: string }) => r.id)).toContain("hash_html");
            const findings = sarif.runs[0].results;
            expect(findings).toHaveLength(1);
            expect(findings[0]).toMatchObject({
                ruleId: "hash_html",
                level: "error",
                properties: { severity: "high" },
            });
            const at = (l: { physicalLocation: { artifactLocation: { uri: string }; region: object } }) => [
                l.physicalLocation.artifactLocation.uri,
                l.physicalLocation.region,
            ];
            // sink is the `h` assigned to innerHTML (1-based col 52), source is `location.hash` (col 11)
            expect(at(findings[0].locations[0])).toEqual([
                "a.js",
                expect.objectContaining({ startLine: 1, startColumn: 52 }),
            ]);
            expect(findings[0].locations[0].physicalLocation.region.snippet.text).toBe("h");
            expect(at(findings[0].relatedLocations[0])).toEqual(["a.js", { startLine: 1, startColumn: 11 }]);
            expect(findings[0].codeFlows[0].threadFlows[0].locations).toHaveLength(2);
            expect(findings[0].properties.hops).toBeGreaterThan(0);

            // one graph per unit, packed into a .tw, finds the same
            const tw = path.join(dir, "app.tw");
            await build(js, tw);
            await analyze(tw, q, outs);
            expect(JSON.parse(fs.readFileSync(out, "utf-8")).runs[0].results).toEqual(findings);

            // a manifest that names a graph outside the archive is rejected, and that graph is left alone
            const evil = path.join(dir, "evil");
            fs.mkdirSync(evil);
            fs.writeFileSync(
                path.join(evil, "manifest.json"),
                JSON.stringify({ format: 1, units: [{ pg: "../app.pg" }] })
            );
            await tar.c({ file: path.join(dir, "evil.tw"), cwd: evil }, ["manifest.json"]);

            const exit = exits();
            await expect(build(js, pg)).rejects.toThrow("exit 38"); // output exists
            await expect(build(path.join(dir, "nope"), path.join(dir, "x.pg"))).rejects.toThrow("exit 37");
            await expect(analyze(path.join(dir, "nope.pg"), q, outs)).rejects.toThrow("exit 39");
            await expect(analyze(path.join(dir, "evil.tw"), q, outs)).rejects.toThrow("exit 39");
            expect(fs.existsSync(pg)).toBe(true);
            expect(exit).toHaveBeenCalledTimes(4);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("writes a sink's interceptors to the JSON, and to the SARIF only when asked", async () => {
        const dir = tmp();
        const js = path.join(dir, "js");
        const q = path.join(dir, "q");
        fs.mkdirSync(js);
        fs.mkdirSync(q);
        fs.writeFileSync(
            path.join(js, "a.js"),
            "const h = location.hash;\nif (h.length > 2) document.body.innerHTML = h;"
        );
        fs.writeFileSync(path.join(q, "lib.pgq"), LIB);
        // the guard query of the pack, cut down: an if whose test holds a node of the flow
        const guard = `MATCH (g:IfStatement)-[:SON {key: 'consequent'}]->(br)-[:SON*0..10]->(k), (g)-[:SON {key: 'test'}]->(n)
WHERE k.id = $sink AND EXISTS { MATCH (n)-[:SON*0..10]->(x) WHERE x.id IN $flow }
RETURN n.id AS id, 'if' AS kind, 'must be true' AS text, ${AT}`;
        fs.writeFileSync(
            path.join(q, "rule.pgq"),
            RULE.replace(
                "return: [{ from: hashRead,",
                `return: [{ from: hashRead, interceptors: [{ query: \`${guard}\` }],`
            )
        );
        const pg = path.join(dir, "app.pg");
        const json = path.join(dir, "taintwire.json");
        const sarif = path.join(dir, "taintwire.sarif");
        try {
            await build(js, pg);
            await analyze(pg, q, { json });
            expect(fs.existsSync(sarif)).toBe(false);
            const [f] = JSON.parse(fs.readFileSync(json, "utf-8"));
            expect(f.interceptors).toEqual([
                { kind: "if", text: "must be true", location: "a.js:2:4", code: "h.length > 2" },
            ]);
            expect(f.explanation).toEqual({
                interceptors: {
                    barrier: null,
                    kinds: ["if"],
                    reason: expect.stringContaining("no interceptor policy"),
                },
            });

            await analyze(pg, q, { json, sarif });
            const [r] = JSON.parse(fs.readFileSync(sarif, "utf-8")).runs[0].results;
            expect(r.relatedLocations[1]).toMatchObject({
                id: 2,
                message: { text: "interceptor: if, must be true" },
                physicalLocation: { region: { startLine: 2, startColumn: 5, snippet: { text: "h.length > 2" } } },
            });
            // source, the guard as a branch step, sink
            const steps = r.codeFlows[0].threadFlows[0].locations;
            expect(steps.map((s: { location: { message: { text: string } } }) => s.location.message.text)).toEqual([
                "source",
                "if, must be true",
                "sink",
            ]);
            expect(steps[1].kinds).toEqual(["branch"]);
            expect(r.properties.interceptors).toEqual([
                { kind: "if", text: "must be true", file: "a.js", line: 2, column: 5, code: "h.length > 2" },
            ]);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("validate passes good queries and exits 40 on bad ones", async () => {
        const dir = tmp();
        try {
            fs.writeFileSync(path.join(dir, "lib.pgq"), LIB);
            fs.writeFileSync(path.join(dir, "rule.pgq"), RULE);
            await validate(dir);

            const exit = exits();
            fs.writeFileSync(
                path.join(dir, "bad.pgq"),
                `export default { id: "b", name: "b", severity: "urgent", message: "m", return: [] };`
            );
            await expect(validate(dir)).rejects.toThrow("exit 40");
            fs.rmSync(path.join(dir, "bad.pgq"));
            fs.writeFileSync(
                path.join(dir, "syntax.pgq"),
                `export default { id: "s", name: "s", severity: "low", message: "m", return: [{ query: "MATCH (n RETURN n" }] };`
            );
            await expect(validate(dir)).rejects.toThrow("exit 40");
            await expect(validate(path.join(dir, "missing"))).rejects.toThrow("exit 40");
            expect(exit).toHaveBeenCalledTimes(3);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
