import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import v8 from "v8";
import vm from "vm";

v8.setFlagsFromString("--expose-gc");
const gc = vm.runInNewContext("gc") as () => void;
const heapAfterGc = (): number => {
    gc();
    gc();
    return process.memoryUsage().heapUsed;
};

// Heap retained (after GC) at the moment the second pass first asks for callers.
let heapAtFirstGetCallers: number | null = null;
vi.mock("../../map/vue_js/taint_utils.js", async (importOriginal) => {
    const mod: any = await importOriginal();
    return {
        ...mod,
        makeGetCallers: (...args: any[]) => {
            const getCallers = mod.makeGetCallers(...args);
            return Object.assign((...a: any[]) => {
                if (heapAtFirstGetCallers === null) heapAtFirstGetCallers = heapAfterGc();
                return getCallers(...a);
            }, getCallers);
        },
    };
});

const { default: vue_resolveFetch } = await import("../../map/vue_js/vue_resolveFetch.js");

// One bundle whose AST (plus Babel's path/scope caches) is far larger than its
// source: lots of small object literals and scopes. The fetch URL depends on a
// param of a named function, so the second pass must walk back to its callers.
const PAD = Array.from({ length: 6000 }, (_, i) => `const p${i} = { a: () => ${i}, b: [${i}, "x"], c: { d: ${i} } };`);
const SOURCE = [
    `function loadThing(id) { return fetch("/api/things/" + id, { method: "POST" }); }`,
    ...PAD,
    `loadThing("abc");`,
].join("\n");

describe("vue_resolveFetch memory retention", () => {
    let dir: string;

    beforeAll(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "jsr-fetch-retain-"));
        fs.writeFileSync(path.join(dir, "app.js"), SOURCE);
        vi.spyOn(console, "log").mockImplementation(() => {});
    });

    afterAll(() => {
        vi.restoreAllMocks();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it("does not keep per-file ASTs alive into the caller-resolution pass", async () => {
        const baseline = heapAfterGc();
        await vue_resolveFetch(dir, "React");
        expect(heapAtFirstGetCallers).not.toBeNull();
        // A single retained parse+traverse of this fixture is ~100x its source
        // size; allow well under one copy.
        expect(heapAtFirstGetCallers! - baseline).toBeLessThan(SOURCE.length * 20);
    }, 60_000);
});
