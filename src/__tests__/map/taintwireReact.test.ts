import { describe, it, expect } from "vitest";
import * as taintwire from "@js-recon/taintwire";
import { resolveApiCalls, ApiCall } from "../../map/taintwire/react_js/index.js";

const resolve = async (code: string): Promise<ApiCall[]> => {
    const graph = await taintwire.import(code, { filename: "app.js", parser: "babel" });
    try {
        return await resolveApiCalls(graph);
    } finally {
        await graph.close();
    }
};

const urlsOf = (calls: ApiCall[], kind: ApiCall["kind"]): string[] =>
    calls
        .filter((c) => c.kind === kind)
        .flatMap((c) => c.urls)
        .sort();

describe("taintwire resolveApiCalls", { timeout: 30000 }, () => {
    it("resolves fetch URLs built from literals, templates, concat, conditionals and defaults", async () => {
        const calls = await resolve(`
            fetch("/api/a");
            fetch(\`/api/b/\${id}\`);
            fetch("/api/c/".concat(id));
            const u = t ? \`/api/d?tag=\${t}\` : "/api/d";
            fetch(u);
            const f = q.get("file") || "readme";
            fetch("/api/e/" + f);
        `);
        expect(urlsOf(calls, "fetch")).toEqual([
            "/api/a",
            "/api/b/[var id]",
            "/api/c/[var id]",
            "/api/d",
            "/api/d?tag=[var t]",
            "/api/e/[call:q.get()]",
            "/api/e/readme",
        ]);
    });

    it("reads method, headers (through a module const) and a JSON.stringify body from fetch options", async () => {
        const [call] = await resolve(`
            const KEY = "k-1";
            fetch("/api/comments", {
                method: "post",
                headers: { "Content-Type": "application/json", "X-Key": KEY },
                body: JSON.stringify({ postId: id, n: 1 }),
            });
        `);
        expect(call.method).toBe("POST");
        expect(call.headers).toEqual({ "Content-Type": "application/json", "X-Key": "k-1" });
        expect(JSON.parse(call.body)).toEqual({ postId: "[var id]", n: "1" });
    });

    it("fans a local fetch wrapper out to every caller, and follows a fetch alias", async () => {
        const calls = await resolve(`
            function getJson(path) { return fetch("/api/v2" + path); }
            getJson("/users");
            getJson("/teams");
            const f = fetch;
            f("/api/alias");
        `);
        expect(urlsOf(calls, "fetch")).toEqual(["/api/alias", "/api/v2/teams", "/api/v2/users"]);
    });

    it("groups XHR open / setRequestHeader / send on one instance", async () => {
        const calls = await resolve(`
            const TOKEN = "t-1";
            function up(form) {
                const xhr = new XMLHttpRequest();
                xhr.open("put", "/api/upload/" + id);
                xhr.setRequestHeader("X-Token", TOKEN);
                xhr.send(JSON.stringify({ a: 1 }));
            }
        `);
        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({
            kind: "XHR",
            urls: ["/api/upload/[var id]"],
            method: "PUT",
            headers: { "X-Token": "t-1" },
            body: '{"a":"1"}',
        });
    });

    it("resolves HTTP-client calls and skips Map.get-style lookalikes", async () => {
        const calls = await resolve(`
            const base = "/api";
            api.get(base + "/reports/" + id);
            api.post("/reports", { title: t }, { headers: { "X-Src": "web" } });
            api.delete(\`/reports/\${id}\`);
            cache.get("key");
            cache.get(k);
            this.get("/not-a-client");
        `);
        const client = calls.filter((c) => c.kind === "client");
        expect(client.map((c) => `${c.method} ${c.urls.join(",")}`).sort()).toEqual([
            "DELETE /reports/[var id]",
            "GET /api/reports/[var id]",
            "POST /reports",
        ]);
        const post = client.find((c) => c.method === "POST")!;
        expect(post.headers).toEqual({ "X-Src": "web" });
        expect(JSON.parse(post.body)).toEqual({ title: "[var t]" });
    });

    it("finds a literal-only HTTP-client call in a graph with no other value flow", async () => {
        // Ladybug returns no zero-hop flow path from a node type without FLOWS_TO edges.
        const calls = await resolve('axios.get("/api/users");');
        expect(calls.map((c) => `${c.kind} ${c.method} ${c.urls.join(",")}`)).toEqual(["client GET /api/users"]);
    });

    it("takes the body of put/patch from the second argument and the config from the third", async () => {
        const [call] = await resolve('api.put("/api/items/1", { name: n }, { headers: { "X-A": "1" } });');
        expect(JSON.parse(call.body)).toEqual({ name: "[var n]" });
        expect(call.headers).toEqual({ "X-A": "1" });
    });

    it("terminates on self-referencing value flow", async () => {
        const calls = await resolve('let u = "/api/a"; u = u + "/b"; fetch(u);');
        expect(calls[0].urls).toContain("/api/a");
    });

    it("returns [] for code with none of the sinks", async () => {
        expect(await resolve("const a = 1 + 2;")).toEqual([]);
    });
});
