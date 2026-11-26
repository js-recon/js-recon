import { describe, it, expect } from "vitest";
import { explain, explainConfinements, isConfined } from "../../taintwire/confined.js";
import { sarifResult } from "../../taintwire/index.js";

describe("isConfined", () => {
    it("suppresses a position that is a barrier for the rule", () => {
        expect(isConfined("open_redirect_url", [{ kind: "path" }])).toBe(true);
        expect(isConfined("jquery_selector_url", [{ kind: "selector" }])).toBe(true);
        expect(isConfined("dom_data_manipulation", [{ kind: "sink" }])).toBe(true);
    });

    it("keeps a path or origin for a request: '../' still traverses", () => {
        expect(isConfined("cspt_url_request", [{ kind: "path" }])).toBe(false);
        expect(isConfined("cspt_url_request", [{ kind: "origin" }])).toBe(false);
        expect(isConfined("cspt_url_request", [{ kind: "path" }, { kind: "query" }])).toBe(true);
    });

    it("never suppresses a rule outside the table, or a finding without confinements", () => {
        expect(isConfined("script_injection_url", [{ kind: "path" }])).toBe(false);
        expect(isConfined("open_redirect_url", [])).toBe(false);
        expect(isConfined("open_redirect_url")).toBe(false);
    });
});

describe("sarifResult confinements", () => {
    it("adds confinements as related locations after the interceptors and in the property bag", () => {
        const at = { file: "a.js", line: 3, col: 4 };
        const r = sarifResult(
            {
                ruleId: "open_redirect_url",
                severity: "medium",
                message: "m",
                id: "s",
                ...at,
                source: { id: "src", file: "a.js", line: 1, col: 0 },
                hops: 2,
                interceptors: [{ id: "g", kind: "if", text: "must be true", file: "a.js", line: 2, col: 4 }],
                confinements: [{ id: "c", kind: "path", text: 'after "/news/"', file: "a.js", line: 3, col: 9 }],
            },
            "u",
            ["u"],
            ['"/news/" + u']
        );
        expect(r.relatedLocations!.map((l) => [l.id, l.message.text])).toEqual([
            [1, "source"],
            [2, "interceptor: if, must be true"],
            [3, 'confinement: path, after "/news/"'],
        ]);
        expect(r.properties.confinements).toEqual([
            { kind: "path", text: 'after "/news/"', file: "a.js", line: 3, column: 10, code: '"/news/" + u' },
        ]);
        expect(r.properties.explanation).toEqual({
            interceptors: { barrier: null, kinds: ["if"], reason: expect.stringContaining("no interceptor policy") },
            confinements: { barrier: true, kinds: ["path"], reason: expect.stringContaining("same-origin path") },
        });
        // a confinement isn't a step of the code flow
        expect(r.codeFlows![0].threadFlows[0].locations).toHaveLength(3);
    });
});

describe("explanation", () => {
    it("says which confinement kinds are a barrier for the rule, and why", () => {
        expect(explainConfinements("cspt_url_request", [{ kind: "path" }, { kind: "query" }])).toEqual({
            barrier: true,
            kinds: ["path", "query"],
            reason: "the value lands in the query, a barrier for cspt_url_request",
        });
        expect(explainConfinements("cspt_url_request", [{ kind: "path" }])).toEqual({
            barrier: false,
            kinds: ["path"],
            reason: "path is not a barrier for cspt_url_request (only query, fragment)",
        });
        expect(explainConfinements("script_injection_url", [{ kind: "path" }])?.barrier).toBe(false);
        expect(explainConfinements("open_redirect_url", [])).toBeUndefined();
    });

    it("keeps interceptors and confinements apart, each side only when present", () => {
        const g = { id: "g", kind: "if", text: "must be true", file: "a.js", line: 2, col: 4 };
        expect(explain({ ruleId: "open_redirect_url", interceptors: [g] })).toEqual({
            interceptors: { barrier: null, kinds: ["if"], reason: expect.any(String) },
        });
        expect(explain({ ruleId: "open_redirect_url", confinements: [{ kind: "sink" }] })).toEqual({
            confinements: { barrier: false, kinds: ["sink"], reason: expect.any(String) },
        });
        expect(explain({ ruleId: "open_redirect_url" })).toEqual({});
    });
});
