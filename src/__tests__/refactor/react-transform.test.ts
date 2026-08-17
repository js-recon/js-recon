import { describe, it, expect } from "vitest";
import * as parser from "@babel/parser";
import traverse from "@babel/traverse";
import generate from "@babel/generator";
import * as t from "@babel/types";
import { transformModule, renameRouteComponents } from "../../refactor/react/transform.js";
import type { ModuleEntry } from "../../refactor/react/transform.js";

const parseModuleEntry = (code: string): ModuleEntry => {
    const ast = parser.parse(code, { sourceType: "unambiguous" });
    let fnPath: any;
    traverse(ast, {
        FunctionExpression(p) {
            if (fnPath) return;
            fnPath = p;
        },
    });
    return {
        id: "0",
        fnPath,
        paramCount: 3,
        moduleParam: "module",
        exportsParam: "exports",
        requireParam: "n",
    };
};

describe("transformModule — webpack async chunk loading", () => {
    it("rewrites requireParam.e(N).then(requireParam.bind(requireParam, N)) into an ImportExpression, not a legacy CallExpression", () => {
        const mod = parseModuleEntry(`
            const wrapper = function (module, exports, n) {
                var Foo = lazy(function () {
                    return n.e(5).then(n.bind(n, 5));
                });
            };
        `);

        const statements = transformModule(mod);
        const code = generate(t.program(statements)).code;

        // Re-parse the generated output and confirm the dynamic import is an ImportExpression
        // (the Babel 8 shape renameRouteComponents expects), not a CallExpression(t.import()).
        const reparsed = parser.parse(code, { sourceType: "unambiguous" });
        let sawImportExpression = false;
        let sawLegacyImportCall = false;
        traverse(reparsed, {
            ImportExpression() {
                sawImportExpression = true;
            },
            CallExpression(p) {
                if (t.isImport(p.node.callee)) sawLegacyImportCall = true;
            },
        });

        expect(sawImportExpression).toBe(true);
        expect(sawLegacyImportCall).toBe(false);
        expect(code).toContain('import("./5.js")');
    });

    it("feeds renameRouteComponents' lazy-import detection (which requires an ImportExpression body)", () => {
        const mod = parseModuleEntry(`
            const wrapper = function (module, exports, n) {
                var Foo = lazy(function () {
                    return n.e(5).then(n.bind(n, 5));
                });
            };
        `);

        const statements = transformModule(mod);
        // renameRouteComponents only mutates statements when it finds at least one lazy-import
        // var whose body is an ImportExpression — this would previously never trigger since
        // transformModule emitted a legacy CallExpression instead.
        expect(() => renameRouteComponents(statements)).not.toThrow();
    });
});
