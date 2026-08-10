import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
    buildStateTreeHeader,
    computeStrongRscKey,
    computeLegacyRscKey,
    buildAncestorAttempts,
    containsNextRedirectMarker,
    extractChunkPathsFromFlightBody,
    extractParamNameCandidatesFromFlightBody,
} from "../../lazyLoad/next_js/next_routerStateForge.js";

describe("buildStateTreeHeader", () => {
    it("builds a single-ancestor page tree matching the reference PoC shape", () => {
        const decoded = JSON.parse(decodeURIComponent(buildStateTreeHeader(["dashboard"])));
        expect(decoded).toEqual(["", { children: ["dashboard", { children: ["__PAGE__", {}] }] }]);
    });

    it("nests multiple ancestor segments in order", () => {
        const decoded = JSON.parse(decodeURIComponent(buildStateTreeHeader(["organizations", "acme"])));
        expect(decoded).toEqual([
            "",
            { children: ["organizations", { children: ["acme", { children: ["__PAGE__", {}] }] }] },
        ]);
    });

    it("marks the leaf metadata-only when requested", () => {
        const decoded = JSON.parse(decodeURIComponent(buildStateTreeHeader(["dashboard"], "metadata-only")));
        expect(decoded).toEqual([
            "",
            { children: ["dashboard", { children: ["__PAGE__", {}, null, "metadata-only"] }] },
        ]);
    });

    it("encodes a dynamic-segment ancestor as a [paramName, value, 'd'] tuple, matching Next.js's matchSegment", () => {
        const decoded = JSON.parse(decodeURIComponent(buildStateTreeHeader([{ paramName: "org", value: "acme" }])));
        expect(decoded).toEqual(["", { children: [["org", "acme", "d"], { children: ["__PAGE__", {}] }] }]);
    });

    it("mixes static and dynamic ancestor segments", () => {
        const decoded = JSON.parse(
            decodeURIComponent(buildStateTreeHeader(["organizations", { paramName: "org", value: "acme" }]))
        );
        expect(decoded).toEqual([
            "",
            {
                children: ["organizations", { children: [["org", "acme", "d"], { children: ["__PAGE__", {}] }] }],
            },
        ]);
    });
});

describe("computeStrongRscKey", () => {
    it("is deterministic for identical inputs", () => {
        const a = computeStrongRscKey("tree", "/dashboard");
        const b = computeStrongRscKey("tree", "/dashboard");
        expect(a).toBe(b);
    });

    it("changes when the state tree changes", () => {
        const a = computeStrongRscKey("tree-a", "/dashboard");
        const b = computeStrongRscKey("tree-b", "/dashboard");
        expect(a).not.toBe(b);
    });

    it("matches a manually computed SHA-256/96-bit/base64url reference value", () => {
        const input = ["0", "0", "tree", "/dashboard"].join(",");
        const digest = createHash("sha256").update(input).digest();
        const expected = digest
            .subarray(0, 12)
            .toString("base64")
            .replace(/\+/g, "-")
            .replace(/\//g, "_")
            .replace(/=+$/, "");
        expect(computeStrongRscKey("tree", "/dashboard")).toBe(expected);
    });

    it("never contains base64 padding or URL-unsafe characters", () => {
        const key = computeStrongRscKey("tree", "/dashboard");
        expect(key).not.toMatch(/[+/=]/);
    });
});

describe("computeLegacyRscKey", () => {
    const referenceDjb2Hash = (str: string): number => {
        let hash = 5381;
        for (let i = 0; i < str.length; i++) {
            hash = ((hash << 5) + hash + str.charCodeAt(i)) & 0xffffffff;
        }
        return hash >>> 0;
    };

    it("is deterministic for identical inputs", () => {
        const a = computeLegacyRscKey("tree", "/dashboard");
        const b = computeLegacyRscKey("tree", "/dashboard");
        expect(a).toBe(b);
    });

    it("changes when the state tree changes", () => {
        const a = computeLegacyRscKey("tree-a", "/dashboard");
        const b = computeLegacyRscKey("tree-b", "/dashboard");
        expect(a).not.toBe(b);
    });

    it("matches a manually computed djb2Hash/base36/5-char reference value", () => {
        const input = ["0", "0", "tree", "/dashboard"].join(",");
        const expected = referenceDjb2Hash(input).toString(36).slice(0, 5);
        expect(computeLegacyRscKey("tree", "/dashboard")).toBe(expected);
    });

    it("is at most 5 characters", () => {
        expect(
            computeLegacyRscKey("a-much-longer-state-tree-value", "/some/deep/nested/path").length
        ).toBeLessThanOrEqual(5);
    });

    it("differs from the strong key for the same inputs", () => {
        expect(computeLegacyRscKey("tree", "/dashboard")).not.toBe(computeStrongRscKey("tree", "/dashboard"));
    });
});

describe("buildAncestorAttempts", () => {
    it("returns nothing for an empty path", () => {
        expect(buildAncestorAttempts([])).toEqual([]);
    });

    it("tries only the first segment for a two-segment path (first-only === all-but-leaf)", () => {
        expect(buildAncestorAttempts(["dashboard", "secret"])).toEqual([["dashboard"]]);
    });

    it("tries first-segment, all-but-leaf, and dynamic-param guesses on the last ancestor for a deeper path", () => {
        const attempts = buildAncestorAttempts(["organizations", "acme", "reports"]);
        expect(attempts[0]).toEqual(["organizations"]);
        expect(attempts[1]).toEqual(["organizations", "acme"]);
        // Every subsequent attempt re-tries the same ancestor set with "acme" as a guessed
        // dynamic param value instead of a literal static segment.
        expect(attempts.slice(2)).toEqual(
            attempts.slice(2).map((_, i) => ["organizations", { paramName: expect.any(String), value: "acme" }])
        );
        expect(attempts.length).toBeGreaterThan(2);
    });

    it("returns a single attempt for a single-segment path", () => {
        expect(buildAncestorAttempts(["dashboard"])).toEqual([["dashboard"]]);
    });

    it("guesses a dynamic param for a single-ancestor path when the leaf itself could be dynamic", () => {
        // ["org", "reports"] -> allButLeaf = ["org"]; no static/dynamic distinction to make
        // since allButLeaf === attempts[0], so only the plain-string attempt is produced.
        expect(buildAncestorAttempts(["org", "reports"])).toEqual([["org"]]);
    });

    it("uses a custom candidate list instead of the default wordlist when provided", () => {
        const attempts = buildAncestorAttempts(["organizations", "acme", "reports"], ["workspace"]);
        expect(attempts).toEqual([
            ["organizations"],
            ["organizations", "acme"],
            ["organizations", { paramName: "workspace", value: "acme" }],
        ]);
    });
});

describe("containsNextRedirectMarker", () => {
    it("detects the marker", () => {
        expect(containsNextRedirectMarker('1:"$Sreact.fragment"\n2:{"NEXT_REDIRECT":"/login"}')).toBe(true);
    });

    it("returns false when absent", () => {
        expect(containsNextRedirectMarker('1:"$Sreact.fragment"\n2:{"secret":"value"}')).toBe(false);
    });

    it("returns false for empty input", () => {
        expect(containsNextRedirectMarker("")).toBe(false);
    });
});

describe("extractChunkPathsFromFlightBody", () => {
    it("extracts a bare static/chunks/*.js path with no _next/ prefix (the real wire format)", () => {
        // e.g. 4:I[3330,["614","static/chunks/app/dashboard/secret/page-<hash>.js"],"default"]
        const body = '4:I[3330,["614","static/chunks/app/dashboard/secret/page-827315aa691298f6.js"],"default"]';
        expect(extractChunkPathsFromFlightBody(body)).toEqual([
            "static/chunks/app/dashboard/secret/page-827315aa691298f6.js",
        ]);
    });

    it("extracts a webpack chunk path with a _next/ prefix", () => {
        const body = '2:I["/_next/static/chunks/app/dashboard/page-abc123.js",[],""]';
        expect(extractChunkPathsFromFlightBody(body)).toEqual(["_next/static/chunks/app/dashboard/page-abc123.js"]);
    });

    it("extracts Turbopack ~-separated chunk names", () => {
        const body = '2:I["_next/static/chunks/18865ghy~7gi9.js",[],""]';
        expect(extractChunkPathsFromFlightBody(body)).toEqual(["_next/static/chunks/18865ghy~7gi9.js"]);
    });

    it("dedupes repeated references", () => {
        const body = "/_next/static/chunks/a.js /_next/static/chunks/a.js";
        expect(extractChunkPathsFromFlightBody(body)).toEqual(["_next/static/chunks/a.js"]);
    });

    it("returns [] when no chunk paths are present", () => {
        expect(extractChunkPathsFromFlightBody('1:"$Sreact.fragment"')).toEqual([]);
    });
});

describe("extractParamNameCandidatesFromFlightBody", () => {
    it("extracts a param name anchored to a known value via the object-key pattern", () => {
        const body = '3:{"workspace":"acme-corp","other":"x"}';
        expect(extractParamNameCandidatesFromFlightBody(body, "acme-corp")).toEqual(["workspace"]);
    });

    it("dedupes multiple keys anchored to the same value", () => {
        const body = '3:{"workspace":"acme-corp"} 5:{"workspace":"acme-corp"}';
        expect(extractParamNameCandidatesFromFlightBody(body, "acme-corp")).toEqual(["workspace"]);
    });

    it("filters out noise keys like id, key, and children", () => {
        const body = '3:{"id":"acme-corp","key":"acme-corp","children":"acme-corp","workspace":"acme-corp"}';
        expect(extractParamNameCandidatesFromFlightBody(body, "acme-corp")).toEqual(["workspace"]);
    });

    it("extracts a param name from a dev-mode webpack module source path, independent of knownValue", () => {
        const body = "webpack-internal:///(rsc)/./app/organizations/[workspace]/layout.tsx";
        expect(extractParamNameCandidatesFromFlightBody(body, "irrelevant")).toEqual(["workspace"]);
    });

    it("returns [] when there is no match", () => {
        expect(extractParamNameCandidatesFromFlightBody('1:"$Sreact.fragment"', "acme-corp")).toEqual([]);
    });

    it("returns [] for an empty knownValue instead of matching everything", () => {
        expect(extractParamNameCandidatesFromFlightBody('3:{"workspace":""}', "")).toEqual([]);
    });

    it("escapes regex-special characters in knownValue and still matches literally", () => {
        const body = '3:{"workspace":"acme.corp+1"}';
        expect(extractParamNameCandidatesFromFlightBody(body, "acme.corp+1")).toEqual(["workspace"]);
        // A regex-unsafe interpretation of "." would also match "acmeXcorp+1" — confirm it doesn't.
        expect(extractParamNameCandidatesFromFlightBody('3:{"workspace":"acmeXcorp+1"}', "acme.corp+1")).toEqual([]);
    });
});
