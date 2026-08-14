import { describe, it, expect } from "vitest";
import { extractInlineScriptJsPaths } from "../../lazyLoad/svelte/svelte_getFromPageSource.js";

describe("extractInlineScriptJsPaths", () => {
    it("extracts a path from a dynamic import(...) call", () => {
        const body = `Promise.all([import("./_app/immutable/entry/start.js"), import("./_app/immutable/entry/app.js")]).then(([x, y]) => {});`;
        const result = extractInlineScriptJsPaths(body);
        expect(result).toEqual(["./_app/immutable/entry/start.js", "./_app/immutable/entry/app.js"]);
    });

    it("extracts a path from a static named import declaration", () => {
        const body = `import { start } from "./_app/immutable/start-abc123.js";\nstart({ target: document.body });`;
        const result = extractInlineScriptJsPaths(body);
        expect(result).toEqual(["./_app/immutable/start-abc123.js"]);
    });

    it("extracts a path from a static default import declaration", () => {
        const body = `import Foo from "./foo.js";`;
        expect(extractInlineScriptJsPaths(body)).toEqual(["./foo.js"]);
    });

    it("extracts a path from a static namespace import declaration", () => {
        const body = `import * as ns from "./ns.js";`;
        expect(extractInlineScriptJsPaths(body)).toEqual(["./ns.js"]);
    });

    it("extracts paths from both dynamic and static import forms in the same body, deduped", () => {
        const body = `
            import { start } from "./_app/immutable/start-abc123.js";
            Promise.all([import("./_app/immutable/entry/start.js")]);
            import { start as start2 } from "./_app/immutable/start-abc123.js";
        `;
        const result = extractInlineScriptJsPaths(body);
        expect(result).toEqual(["./_app/immutable/entry/start.js", "./_app/immutable/start-abc123.js"]);
    });

    it("does not match non-.js import specifiers", () => {
        const body = `import "./styles.css";`;
        expect(extractInlineScriptJsPaths(body)).toEqual([]);
    });

    it("returns [] for empty input", () => {
        expect(extractInlineScriptJsPaths("")).toEqual([]);
    });

    it("extracts the modern entry path from a Sapper boot script, dropping the /legacy/ variant", () => {
        const body = `
            __SAPPER__={baseUrl:"",preloaded:[]};
            if('serviceWorker' in navigator) navigator.serviceWorker.register('/service-worker.js');
            (function(){
                try {
                    eval("async function x(){}");
                    var main="/client/client.abc123.js"
                } catch(e) {
                    main="/client/legacy/client.abc123.js"
                };
                var s=document.createElement("script");
                try {
                    new Function("if(0)import('')")();
                    s.src=main; s.type="module"; s.crossOrigin="use-credentials";
                } catch(e) {
                    s.src="/client/shimport@2.0.5.js"; s.setAttribute("data-main",main);
                }
                document.head.appendChild(s);
            }());
        `;
        const result = extractInlineScriptJsPaths(body);
        expect(result).toEqual(["/service-worker.js", "/client/client.abc123.js", "/client/shimport@2.0.5.js"]);
    });

    it("keeps the /legacy/ path literal when no modern variant is present", () => {
        const body = `var main="/client/legacy/client.abc123.js";`;
        expect(extractInlineScriptJsPaths(body)).toEqual(["/client/legacy/client.abc123.js"]);
    });

    it("does not run the string-literal fallback when an import(...) match already exists", () => {
        const body = `
            Promise.all([import("./_app/immutable/entry/start.js")]);
            var unrelated = "/client/legacy/client.abc123.js";
        `;
        const result = extractInlineScriptJsPaths(body);
        expect(result).toEqual(["./_app/immutable/entry/start.js"]);
    });

    it("returns [] when the body has no .js string literals", () => {
        expect(extractInlineScriptJsPaths(`var x = "not a js path";`)).toEqual([]);
    });
});
