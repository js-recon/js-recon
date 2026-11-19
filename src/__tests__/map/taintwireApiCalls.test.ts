import { describe, it, expect } from "vitest";
import * as taintwire from "@js-recon/taintwire";
import fs from "fs";
import os from "os";
import path from "path";
import { resolveApiCalls, ApiCall, withLinkedGraph } from "../../map/taintwire/apiCalls.js";
import { moduleSpans, resolveServerActions } from "../../map/taintwire/next_js/index.js";
import { Chunks } from "../../utility/interfaces.js";

const withGraph = async <T>(code: string, fn: (graph: taintwire.PookieGraph) => Promise<T>): Promise<T> => {
    const graph = await taintwire.import(code, { filename: "app.js", parser: "babel" });
    try {
        return await fn(graph);
    } finally {
        await graph.close();
    }
};

const resolve = (code: string): Promise<ApiCall[]> => withGraph(code, resolveApiCalls);

const urlsOf = (calls: ApiCall[], kind: ApiCall["kind"]): string[] =>
    calls
        .filter((c) => c.kind === kind)
        .flatMap((c) => c.urls)
        .sort();

describe("taintwire resolveApiCalls", { timeout: 30000 }, () => {
    it("uses the result of a webpack-exported function named concat instead of string concatenation", async () => {
        const graph = await taintwire.PookieGraph.open(":memory:", { parser: "babel" });
        try {
            await graph.addFiles([
                {
                    filename: "a.js",
                    code: `(self.webpackChunk=self.webpackChunk||[]).push([[1],{10:(e,t,n)=>{n.d(t,{concat:()=>c});function c(x){return "/api/real"}}}]);`,
                },
                {
                    filename: "b.js",
                    code: `(self.webpackChunk=self.webpackChunk||[]).push([[2],{20:(e,t,n)=>{var r=n(10);fetch(r.concat("/ignored"));}}]);`,
                },
            ]);
            expect(urlsOf(await resolveApiCalls(graph), "fetch")).toEqual(["/api/real"]);
        } finally {
            await graph.close();
        }
    });

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

    it("treats $fetch (ofetch / Nuxt) like fetch", async () => {
        const [call] = await resolve('$fetch("/api/comments", { method: "POST", body: { a: 1 } });');
        expect(call).toMatchObject({ kind: "fetch", urls: ["/api/comments"], method: "POST", body: '{"a":"1"}' });
    });

    it("follows a fetch handed in by destructuring (SvelteKit load)", async () => {
        const calls = await resolve("const load = async ({ params: n, fetch: t }) => t(`/api/blog/${n.slug}`);");
        expect(urlsOf(calls, "fetch")).toEqual(["/api/blog/[MemberExpression -> n.slug]"]);
    });

    it("recognises compiled Nuxt useFetch calls by their $-key argument", async () => {
        const calls = await resolve(`
            d("/api/posts/1", { key: "p1" }, "$Qx7Lm2Np9R");
            d(\`/api/users/\${id}\`, "$Zt4Wk8Hs3V");
            notFetch("/api/x", "plain");
        `);
        expect(urlsOf(calls, "fetch")).toEqual(["/api/posts/1", "/api/users/[var id]"]);
    });

    it("links every file of a directory into one graph, so a URL reaches fetch from another chunk", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tw-linked-"));
        try {
            // b.js has no sink token at all: it's still loaded, and its URL flows into a.js's fetch.
            fs.writeFileSync(
                path.join(dir, "a.js"),
                `(self.webpackChunk=self.webpackChunk||[]).push([[1],{10:(e,t,n)=>{n.d(t,{go:()=>g});function g(u){return fetch(u)}}}]);`
            );
            fs.writeFileSync(
                path.join(dir, "b.js"),
                `(self.webpackChunk=self.webpackChunk||[]).push([[2],{20:(e,t,n)=>{var r=n(10);r.go("/api/linked")}}]);`
            );
            let calls: ApiCall[] = [];
            await withLinkedGraph(dir, ["a.js", "b.js"], async (g) => {
                calls = await resolveApiCalls(g);
            });
            expect(urlsOf(calls, "fetch")).toEqual(["/api/linked"]);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("finds each Next.js module's span in its chunk file behind the rewritten prefix", () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tw-spans-"));
        try {
            const text = `push([[1],{10:function(e){a()},20:(e,t)=>{b()}}])`;
            fs.writeFileSync(path.join(dir, "c.js"), text);
            const mk = (id: string, code: string) => ({ id, code, file: "c.js" }) as unknown as Chunks[string];
            const chunks: Chunks = {
                "10": mk("10", "function webpack_10 (e){a()}"),
                "20": mk("20", "func_20 = (e,t)=>{b()}"),
            };
            const spans = moduleSpans(chunks, dir).get("c.js")!;
            expect(spans.map((s) => [s.chunk.id, text.slice(s.start, s.end)])).toEqual([
                ["10", "(e){a()}"],
                ["20", "(e,t)=>{b()}"],
            ]);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("prefixes HTTP-client URLs with the baseURL of the create() call the client comes from", async () => {
        const calls = await resolve('const api = axios.create({ baseURL: "/api" }); api.get("/reports/" + id);');
        expect(urlsOf(calls, "client")).toEqual(["/api/reports/[var id]"]);
    });

    it("reads config-object calls: axios({ url, method }) and new X({ url, method })", async () => {
        const calls = await resolve(`
            axios({ url: "/api/a", method: "put", headers: { "X-A": "1" }, data: { n: 1 } });
            new Req({ url: "/api/b/" + id, method: "DELETE" });
            $.ajax({ url: "/api/c", type: "POST" });
            st({ url: "/settings/profile", params: p, route: { id: r } });
            api.request({ url: "/api/d" });
        `);
        expect(
            calls
                .filter((c) => c.kind === "config")
                .map((c) => `${c.method} ${c.urls.join(",")}`)
                .sort()
        ).toEqual(["DELETE /api/b/[var id]", "GET /api/d", "POST /api/c", "PUT /api/a"]);
        expect(calls.find((c) => c.method === "PUT")).toMatchObject({ headers: { "X-A": "1" }, body: '{"n":"1"}' });
    });

    it("finds Next.js server actions and hints their same-module call arguments", async () => {
        const id = "7f".padEnd(42, "a");
        const actions = await withGraph(
            `const save = (0, r.createServerReference)("${id}", r.callServer, void 0, r.findSourceMapURL, "saveNote");
             save(note.title, 3);
             const other = r.createServerReference("${"40".padEnd(42, "b")}", r.callServer);
             r.createServerReference("not-a-hash", r.callServer);`,
            resolveServerActions
        );
        expect(actions.map((a) => a.actionId).sort()).toEqual(["40".padEnd(42, "b"), id].sort());
        const save = actions.find((a) => a.actionId === id)!;
        expect(save.actionName).toBe("saveNote");
        expect(JSON.parse(save.body)).toEqual(["<string:title>", "3"]);
    });

    it("resolves URLs held in React hooks (Vite output: array/object destructuring)", async () => {
        const calls = await resolve(`
            const u = (0, l.createContext)("/api/ctx-default");
            function C({ id: e }) {
                let [t] = (0, l.useState)("/api/state"),
                    [n] = (0, l.useState)(() => "/api/lazy"),
                    r = (0, l.useRef)("/api/ref"),
                    i = (0, l.useMemo)(() => "/api/memo/" + e, [e]),
                    [o] = (0, l.useReducer)(m, { url: "/api/reducer" }),
                    c = (0, l.useContext)(u),
                    [d, f] = (0, l.useState)("");
                fetch(t); fetch(n); fetch(r.current); fetch(i); fetch(o.url); fetch(c);
                f("/api/next"); d && fetch(d);
            }
            function v() { return { base: "/api/obj" } }
            function _() { let [e, t] = (0, l.useState)("/api/arr"); return [e, t] }
            function B() { let { base: n } = v(), [t] = _(); fetch(n + "/list"); fetch(t); }
            const App = () => (0, p.jsx)(u.Provider, { value: "/api/ctx", children: null });
        `);
        expect(urlsOf(calls, "fetch").filter(Boolean)).toEqual(
            [
                "/api/arr",
                "/api/ctx",
                "/api/lazy",
                "/api/memo/[var e]",
                "/api/next",
                "/api/obj/list",
                "/api/reducer",
                "/api/ref",
                "/api/state",
            ].sort()
        );
    });

    it("resolves useState through Babel's slicedToArray (webpack output), setter writes included", async () => {
        const calls = await resolve(`
            function l(e, t) { return e }
            function b() {
                var r = l((0, o.useState)("/api/state"), 1)[0],
                    n = l((0, o.useState)(function () { return "/api/lazy" }), 1)[0],
                    d = l((0, o.useState)(""), 2), h = d[0], m = d[1];
                fetch(r); fetch(n); m("/api/next"); h && fetch(h);
            }
        `);
        expect(urlsOf(calls, "fetch").filter(Boolean)).toEqual(["/api/lazy", "/api/next", "/api/state"]);
    });

    it("follows a URL into a wrapper imported from another ES-module chunk", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tw-esm-"));
        try {
            fs.mkdirSync(path.join(dir, "_nuxt"));
            fs.writeFileSync(
                path.join(dir, "_nuxt/wrap.js"),
                'function a(e,t){return s(e,{...t},"$Ab12Cd34Ef")}export{a as u};'
            );
            fs.writeFileSync(
                path.join(dir, "_nuxt/page.js"),
                'import{u as oe}from"./wrap.js";oe("/api/items",{key:"k"});'
            );
            let calls: ApiCall[] = [];
            await withLinkedGraph(dir, ["_nuxt/wrap.js", "_nuxt/page.js"], async (g) => {
                calls = await resolveApiCalls(g);
            });
            expect(urlsOf(calls, "fetch")).toEqual(["/api/items"]);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("returns [] for code with none of the sinks", async () => {
        expect(await resolve("const a = 1 + 2;")).toEqual([]);
    });
});
