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
        const out = path.join(dir, "out.json");
        try {
            await build(js, pg);
            expect(fs.existsSync(pg)).toBe(true);
            await analyze(pg, q, out);
            const findings = JSON.parse(fs.readFileSync(out, "utf-8"));
            expect(findings).toHaveLength(1);
            expect(findings[0]).toMatchObject({ ruleId: "hash_html", ruleType: "pgq", severity: "high" });
            expect(findings[0].findingLocation).toMatch(/^\/\/ a\.js:1:\d+ <- a\.js:1:\d+ \(\d+ hops\)/);

            // one graph per unit, packed into a .tw, finds the same
            const tw = path.join(dir, "app.tw");
            await build(js, tw);
            await analyze(tw, q, out);
            expect(JSON.parse(fs.readFileSync(out, "utf-8"))).toEqual(findings);

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
            await expect(analyze(path.join(dir, "nope.pg"), q, out)).rejects.toThrow("exit 39");
            await expect(analyze(path.join(dir, "evil.tw"), q, out)).rejects.toThrow("exit 39");
            expect(fs.existsSync(pg)).toBe(true);
            expect(exit).toHaveBeenCalledTimes(4);
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
