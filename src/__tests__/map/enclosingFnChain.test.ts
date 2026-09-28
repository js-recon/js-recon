import { describe, it, expect } from "vitest";
import { detachEnclosingFn, enclosingFnChainHasBinding } from "../../map/vue_js/taint_utils.js";
import type { EnclosingFn } from "../../map/vue_js/taint_utils.js";

function makeEnclosingFn(overrides: Partial<EnclosingFn> = {}): EnclosingFn {
    return {
        bindingName: null,
        firstParamName: null,
        paramNames: [],
        node: {},
        file: "test.ts",
        parent: null,
        ...overrides,
    };
}

describe("enclosingFnChainHasBinding", () => {
    it("returns false for null", () => {
        expect(enclosingFnChainHasBinding(null)).toBe(false);
    });

    it("returns false for undefined", () => {
        expect(enclosingFnChainHasBinding(undefined)).toBe(false);
    });

    it("returns true when the fn itself has a bindingName", () => {
        const fn = makeEnclosingFn({ bindingName: "myFn" });
        expect(enclosingFnChainHasBinding(fn)).toBe(true);
    });

    it("returns false when the fn has no bindingName and no parent", () => {
        const fn = makeEnclosingFn({ bindingName: null });
        expect(enclosingFnChainHasBinding(fn)).toBe(false);
    });

    it("returns true when a parent fn has a bindingName", () => {
        const parent = makeEnclosingFn({ bindingName: "outerFn" });
        const child = makeEnclosingFn({ bindingName: null, parent });
        expect(enclosingFnChainHasBinding(child)).toBe(true);
    });

    it("returns true when only a grandparent has a bindingName", () => {
        const grandparent = makeEnclosingFn({ bindingName: "rootFn" });
        const parent = makeEnclosingFn({ bindingName: null, parent: grandparent });
        const child = makeEnclosingFn({ bindingName: null, parent });
        expect(enclosingFnChainHasBinding(child)).toBe(true);
    });

    it("returns false when no fn in the chain has a bindingName", () => {
        const parent = makeEnclosingFn({ bindingName: null });
        const child = makeEnclosingFn({ bindingName: null, parent });
        expect(enclosingFnChainHasBinding(child)).toBe(false);
    });
});

describe("detachEnclosingFn", () => {
    it("returns null for null", () => {
        expect(detachEnclosingFn(null)).toBeNull();
    });

    it("nulls the node on every link of the chain but keeps the metadata", () => {
        const grandparent = makeEnclosingFn({ bindingName: "rootFn", paramNames: ["a"] });
        const parent = makeEnclosingFn({ parent: grandparent });
        const child = makeEnclosingFn({ bindingName: "leaf", parent });
        const out = detachEnclosingFn(child)!;
        expect(out.node).toBeNull();
        expect(out.parent!.node).toBeNull();
        expect(out.parent!.parent!.node).toBeNull();
        expect(out.bindingName).toBe("leaf");
        expect(out.parent!.parent!.bindingName).toBe("rootFn");
        expect(out.parent!.parent!.paramNames).toEqual(["a"]);
        expect(child.parent!.node).toEqual({});
    });
});
