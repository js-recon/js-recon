import { describe, it, expect } from "vitest";
import execFunc from "../../utility/runSandboxed.js";

describe("execFunc", () => {
    it("returns sync builder output", () => {
        expect(execFunc(`function(e){return "/_next/" + e + ".js"}`, 3)).toBe("/_next/3.js");
    });

    it("contains a rejecting async builder instead of leaking an unhandled rejection", async () => {
        expect(execFunc(`async function(e){return o.e(e) + ".js"}`, 3)).toBeUndefined();
        // let the rejection settle; vitest fails the run on unhandled rejections
        await new Promise((r) => setTimeout(r, 10));
    });
});
