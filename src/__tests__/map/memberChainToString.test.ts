import { describe, it, expect } from "vitest";
import { memberChainToString } from "../../map/babel-legacy/next_js/utils.js";

const ident = (name: string) => ({ type: "Identifier", name });
const member = (object: any, property: string, computed = false) => ({
    type: "MemberExpression",
    object,
    property: ident(property),
    computed,
});

describe("memberChainToString", () => {
    it("returns null for null input", () => {
        expect(memberChainToString(null)).toBeNull();
    });

    it("returns the identifier name for a plain Identifier", () => {
        expect(memberChainToString(ident("foo"))).toBe("foo");
    });

    it("builds dot-path from a simple MemberExpression", () => {
        const node = member(ident("obj"), "prop");
        expect(memberChainToString(node)).toBe("obj.prop");
    });

    it("builds multi-level dot-path", () => {
        const node = member(member(ident("a"), "b"), "c");
        expect(memberChainToString(node)).toBe("a.b.c");
    });

    it("returns null for computed MemberExpression (cannot render as a.b.c)", () => {
        const node = { type: "MemberExpression", object: ident("arr"), property: ident("i"), computed: true };
        expect(memberChainToString(node)).toBeNull();
    });

    it("returns null when chain contains a non-Identifier node type", () => {
        const node = {
            type: "MemberExpression",
            object: { type: "CallExpression", callee: ident("fn"), arguments: [] },
            property: ident("prop"),
            computed: false,
        };
        expect(memberChainToString(node)).toBeNull();
    });

    it("returns null for unrecognised node type", () => {
        expect(memberChainToString({ type: "Literal", value: 42 })).toBeNull();
    });
});
