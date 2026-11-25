import { describe, it, expect } from "vitest";
import { isConfined } from "../../taintwire/confined.js";
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
            [2, "if, must be true"],
            [3, 'confined: path, after "/news/"'],
        ]);
        expect(r.properties.confinements).toEqual([
            { kind: "path", text: 'after "/news/"', file: "a.js", line: 3, column: 10, code: '"/news/" + u' },
        ]);
        // a confinement isn't a step of the code flow
        expect(r.codeFlows![0].threadFlows[0].locations).toHaveLength(3);
    });
});
