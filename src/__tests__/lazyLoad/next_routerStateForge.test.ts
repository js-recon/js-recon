import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
    buildStateTreeHeader,
    computeStrongRscKey,
    computeLegacyRscKey,
    buildAncestorAttempts,
    containsNextRedirectMarker,
    extractChunkPathsFromFlightBody,
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
        expect(computeLegacyRscKey("a-much-longer-state-tree-value", "/some/deep/nested/path").length).toBeLessThanOrEqual(
            5
        );
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

    it("tries both first-segment and all-but-leaf for a deeper path", () => {
        expect(buildAncestorAttempts(["organizations", "acme", "reports"])).toEqual([
            ["organizations"],
            ["organizations", "acme"],
        ]);
    });

    it("returns a single attempt for a single-segment path", () => {
        expect(buildAncestorAttempts(["dashboard"])).toEqual([["dashboard"]]);
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
    it("extracts a webpack chunk path", () => {
        const body = '2:I["/_next/static/chunks/app/dashboard/page-abc123.js",[],""]';
        expect(extractChunkPathsFromFlightBody(body)).toEqual(["/_next/static/chunks/app/dashboard/page-abc123.js"]);
    });

    it("extracts Turbopack ~-separated chunk names", () => {
        const body = '2:I["_next/static/chunks/18865ghy~7gi9.js",[],""]';
        expect(extractChunkPathsFromFlightBody(body)).toEqual(["_next/static/chunks/18865ghy~7gi9.js"]);
    });

    it("dedupes repeated references", () => {
        const body = "/_next/static/chunks/a.js /_next/static/chunks/a.js";
        expect(extractChunkPathsFromFlightBody(body)).toEqual(["/_next/static/chunks/a.js"]);
    });

    it("returns [] when no chunk paths are present", () => {
        expect(extractChunkPathsFromFlightBody('1:"$Sreact.fragment"')).toEqual([]);
    });
});
