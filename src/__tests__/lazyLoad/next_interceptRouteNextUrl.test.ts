import { describe, it, expect } from "vitest";
import {
    extractBuildId,
    parseInterceptRules,
    interceptRuleToRequest,
    matchesNextUrl,
    detectMiddlewareHeaders,
    dataRoutePath,
    assetBase,
    basePathOf,
    chunkUrl,
} from "../../lazyLoad/next_js/next_interceptRouteNextUrl.js";

describe("extractBuildId", () => {
    it("reads the id from a _buildManifest.js reference", () => {
        expect(extractBuildId('<script src="/_next/static/AbC_123-x/_buildManifest.js"></script>')).toBe("AbC_123-x");
    });

    it('reads the Flight root row\'s escaped "b" key inside __next_f.push', () => {
        const html = 'self.__next_f.push([1,"0:{\\"P\\":null,\\"b\\":\\"Zq9nB3xYwV\\",\\"p\\":\\"\\"}"])';
        expect(extractBuildId(html)).toBe("Zq9nB3xYwV");
    });

    it('reads an unescaped "b" key from a raw Flight row', () => {
        expect(extractBuildId('0:{"P":null,"b":"build-16-id","p":""}')).toBe("build-16-id");
    });

    it("reads a short custom id from the Flight root row", () => {
        expect(extractBuildId('0:{"P":null,"b":"abc","p":""}')).toBe("abc");
        expect(extractBuildId('self.__next_f.push([1,"0:{\\"b\\":\\"v1\\",\\"f\\":[]}"])')).toBe("v1");
        // a short "b" outside the root row is not a build id
        expect(extractBuildId('{"a":1,"b":"no"}')).toBeNull();
    });

    it('falls back to Next 14\'s "buildId"', () => {
        expect(extractBuildId('{"props":{},"buildId":"old14build","page":"/"}')).toBe("old14build");
    });

    it("returns null when nothing matches", () => {
        expect(extractBuildId("<html><body>hi</body></html>")).toBeNull();
    });
});

describe("parseInterceptRules", () => {
    it("parses the Next 14 minified object form", () => {
        const js =
            'self.__BUILD_MANIFEST=function(e){return{__rewrites:{afterFiles:[{has:e,source:"/rw-src/:p*",destination:"/rewrite-target"}],' +
            'beforeFiles:[{has:e,source:"/rw-before",destination:"/rewrite-before-target"},' +
            '{has:[{type:"header",key:"Next-Url",value:"\\\\/feed(?:\\\\/(.*))?[\\\\/#\\\\?]?"}],source:"/photo/:id",destination:"/feed/(..)photo/:id"}],fallback:[]}}}(void 0);';
        expect(parseInterceptRules(js)).toEqual([
            { source: "/photo/:id", destination: "/feed/(..)photo/:id", nextUrlRegex: "\\/feed(?:\\/(.*))?[\\/#\\?]?" },
        ]);
    });

    it("parses the Next 16 pretty-printed JSON form", () => {
        const js = `self.__BUILD_MANIFEST = {
  "__rewrites": {
    "afterFiles": [],
    "beforeFiles": [
      {
        "source": "/pub/:nxtPid",
        "destination": "/admin/(..)pub/:nxtPid",
        "has": [{ "type": "header", "key": "next-url", "value": "/admin(?:/.*)?" }]
      }
    ],
    "fallback": []
  },
  "sortedPages": ["/_app", "/_error"]
};`;
        expect(parseInterceptRules(js)).toEqual([
            { source: "/pub/:nxtPid", destination: "/admin/(..)pub/:nxtPid", nextUrlRegex: "/admin(?:/.*)?" },
        ]);
    });

    it("resolves values Next.js hoisted into the manifest IIFE's parameters", () => {
        const js =
            'self.__BUILD_MANIFEST=function(e,s,a,h){return{__rewrites:{beforeFiles:[{has:[{type:h,key:"Next-Url",value:a}],' +
            'source:e,destination:s}],afterFiles:[],fallback:[]}}}("/photo/:id","/feed/(..)photo/:id","/feed(?:/.*)?","header");';
        expect(parseInterceptRules(js)).toEqual([
            { source: "/photo/:id", destination: "/feed/(..)photo/:id", nextUrlRegex: "/feed(?:/.*)?" },
        ]);
    });

    it("ignores rewrites without a next-url header condition", () => {
        expect(parseInterceptRules('x={source:"/a",destination:"/b",has:[{type:"cookie",key:"s"}]}')).toEqual([]);
        // a cookie or query named next-url is not what the Next-Url header satisfies
        expect(
            parseInterceptRules(
                'x={source:"/a",destination:"/b/(..)a",has:[{type:"cookie",key:"next-url",value:"/b"}]}'
            )
        ).toEqual([]);
    });

    it("returns null for a manifest that doesn't parse, so the caller probes without rules", () => {
        expect(parseInterceptRules("{{{{")).toBeNull();
        expect(parseInterceptRules('self.__BUILD_MANIFEST={__rewrites:{beforeFiles:[{source:"/a",')).toBeNull();
    });
});

describe("interceptRuleToRequest", () => {
    it("derives the parent and a concrete source path", () => {
        expect(
            interceptRuleToRequest({
                source: "/pub/:nxtPid",
                destination: "/admin/(..)pub/:nxtPid",
                nextUrlRegex: "/admin(?:/.*)?",
            })
        ).toEqual({ sourcePath: "/pub/1", parentPath: "/admin" });
    });

    it("handles the escaped Next 14 guard", () => {
        expect(
            interceptRuleToRequest({
                source: "/photo/:id",
                destination: "/feed/(..)photo/:id",
                nextUrlRegex: "\\/feed(?:\\/(.*))?[\\/#\\?]?",
            })
        ).toEqual({ sourcePath: "/photo/1", parentPath: "/feed" });
    });

    it("fills dynamic parent segments", () => {
        expect(
            interceptRuleToRequest({
                source: "/item/:nxtPid",
                destination: "/org/:nxtPorg/(...)item/:nxtPid",
                nextUrlRegex: "/org/([^/]+?)(?:/.*)?",
            })
        ).toEqual({ sourcePath: "/item/1", parentPath: "/org/1" });
    });

    it("does not treat a route group as an interception marker", () => {
        expect(interceptRuleToRequest({ source: "/x", destination: "/(auth)/x", nextUrlRegex: "/(auth)" })).toBeNull();
    });

    it("returns null when the parent doesn't satisfy the guard", () => {
        expect(
            interceptRuleToRequest({
                source: "/pub/:nxtPid",
                destination: "/admin/(..)pub/:nxtPid",
                nextUrlRegex: "/other(?:/.*)?",
            })
        ).toBeNull();
    });
});

describe("matchesNextUrl", () => {
    it("anchors the guard and matches descendants", () => {
        expect(matchesNextUrl("/admin(?:/.*)?", "/admin/users")).toBe(true);
        expect(matchesNextUrl("/admin(?:/.*)?", "/administrator")).toBe(false);
    });

    it("gives up on a guard that backtracks catastrophically", () => {
        const started = Date.now();
        expect(matchesNextUrl("(a+)+b", "a".repeat(40))).toBe(false);
        expect(Date.now() - started).toBeLessThan(5000);
        expect(matchesNextUrl("/admin(?:/.*)?", "/admin/x")).toBe(true); // and still matches afterwards
    });

    it("returns false on an invalid regex", () => {
        expect(matchesNextUrl("(", "/a")).toBe(false);
    });
});

describe("detectMiddlewareHeaders", () => {
    it("returns every middleware-revealing header", () => {
        expect(
            detectMiddlewareHeaders({
                "content-type": "text/html",
                "x-nextjs-redirect": "/login",
                "X-Middleware-Rewrite": "/hidden",
                "x-nextjs-rewrite": "/hidden",
                "x-nextjs-matched-path": "/x",
            })
        ).toEqual(["x-nextjs-redirect", "x-middleware-rewrite", "x-nextjs-rewrite"]);
    });

    it("returns [] when none are present", () => {
        expect(detectMiddlewareHeaders({ location: "/login", "x-powered-by": "Next.js" })).toEqual([]);
    });
});

describe("dataRoutePath", () => {
    it("builds the data route for a path and for the root", () => {
        expect(dataRoutePath("abc", "/admin")).toBe("/_next/data/abc/admin.json");
        expect(dataRoutePath("abc", "/admin/")).toBe("/_next/data/abc/admin.json");
        expect(dataRoutePath("abc", "/")).toBe("/_next/data/abc/index.json");
    });

    it("puts the basePath in front of the data route", () => {
        expect(dataRoutePath("abc", "/app/admin", "/app")).toBe("/app/_next/data/abc/admin.json");
        expect(dataRoutePath("abc", "/app", "/app")).toBe("/app/_next/data/abc/index.json");
    });
});

describe("assetBase, basePathOf and chunkUrl", () => {
    const origin = "https://site.test";

    it("keeps a CDN assetPrefix or a basePath from a downloaded chunk URL", () => {
        const cdn = assetBase(["https://cdn.test/pre/_next/static/chunks/a.js"], origin);
        expect(cdn).toBe("https://cdn.test/pre/");
        expect(basePathOf(cdn, origin)).toBe("");
        const app = assetBase([`${origin}/app/_next/static/chunks/a.js`], origin);
        expect(app).toBe(`${origin}/app/`);
        expect(basePathOf(app, origin)).toBe("/app");
        expect(assetBase([], origin)).toBe(`${origin}/`);
    });

    it("resolves both chunk path forms to the same URL under the base", () => {
        const base = "https://cdn.test/pre/";
        expect(chunkUrl("static/chunks/x.js", base)).toBe("https://cdn.test/pre/_next/static/chunks/x.js");
        expect(chunkUrl("_next/static/chunks/x.js", base)).toBe("https://cdn.test/pre/_next/static/chunks/x.js");
    });
});
