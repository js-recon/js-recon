import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { makeGetCallers } from "../../map/vue_js/taint_utils.js";

// Many chunks that each call `loadUser(...)` plus padding, and unrelated chunks
// that don't. With a budget smaller than the combined source, the caller lookup
// must keep its AST cache bounded and still find every caller on repeat calls
// (after earlier chunks were evicted and have to be re-parsed).
const CALLER_COUNT = 10;
const UNRELATED_COUNT = 10;
const FILLER = `const pad = [${Array.from({ length: 5000 }, (_, j) => j).join(",")}];`;
const BUDGET = FILLER.length * 3;

describe("makeGetCallers memory bound", () => {
    let dir: string;
    const files: string[] = [];

    beforeAll(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "jsr-callers-"));
        for (let i = 0; i < CALLER_COUNT; i++) {
            const fp = path.join(dir, `caller-${i}.js`);
            fs.writeFileSync(fp, `${FILLER}\nfunction run${i}() { return loadUser("/api/u${i}"); }`);
            files.push(fp);
        }
        for (let i = 0; i < UNRELATED_COUNT; i++) {
            const fp = path.join(dir, `other-${i}.js`);
            fs.writeFileSync(fp, `${FILLER}\nfunction other${i}() { return 1; }`);
            files.push(fp);
        }
    });

    afterAll(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it("finds callers across evicted files while keeping the AST cache bounded", () => {
        const getCallers = makeGetCallers(files, 128, BUDGET);
        for (let round = 0; round < 2; round++) {
            const callers = getCallers("loadUser");
            expect(callers.map((c) => c.args[0].value).sort()).toEqual(
                Array.from({ length: CALLER_COUNT }, (_, i) => `/api/u${i}`).sort()
            );
            expect(callers.every((c) => c.enclosingFn?.bindingName?.startsWith("run"))).toBe(true);
            expect(getCallers.cachedAstBytes()).toBeGreaterThan(0);
            expect(getCallers.cachedAstBytes()).toBeLessThanOrEqual(BUDGET);
        }
    });

    it("does not parse files that fail the text pre-filter", () => {
        const getCallers = makeGetCallers(files, 128, Number.MAX_SAFE_INTEGER);
        getCallers("loadUser");
        const callerBytes = files.slice(0, CALLER_COUNT).reduce((n, f) => n + fs.readFileSync(f, "utf-8").length, 0);
        expect(getCallers.cachedAstBytes()).toBe(callerBytes);
    });
});
