import path from "path";
import fs from "fs";
import os from "os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { extractSourceMaps, resolveSourceMapOutputPath } from "../../sourcemaps/index.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
});

describe("source-map output containment", () => {
    const outputRoot = path.resolve("/tmp/js-recon-source-map-output");

    it("accepts nested relative source paths", () => {
        expect(resolveSourceMapOutputPath(outputRoot, "src/components/App.tsx")).toBe(
            path.join(outputRoot, "src", "components", "App.tsx")
        );
    });

    it("rejects traversal, POSIX absolute, and Windows absolute source paths", () => {
        expect(resolveSourceMapOutputPath(outputRoot, "../../outside.ts")).toBeNull();
        expect(resolveSourceMapOutputPath(outputRoot, "/tmp/outside.ts")).toBeNull();
        expect(resolveSourceMapOutputPath(outputRoot, "C:\\outside.ts")).toBeNull();
    });

    it("skips a traversing sourceRoot at the directory extraction write boundary", async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "js-recon-source-map-containment-"));
        temporaryDirectories.push(root);
        const assets = path.join(root, "assets");
        const output = path.join(root, "nested", "output");
        fs.mkdirSync(assets, { recursive: true });
        fs.writeFileSync(
            path.join(assets, "hostile.js.map"),
            JSON.stringify({
                version: 3,
                sourceRoot: "../../escape",
                sources: ["outside.ts"],
                sourcesContent: ["export const escaped = true;"],
                names: [],
                mappings: "",
            })
        );
        fs.writeFileSync(path.join(assets, "invalid.js.map"), JSON.stringify({ version: 3 }));
        fs.writeFileSync(
            path.join(assets, "invalid-content.js.map"),
            JSON.stringify({
                version: 3,
                sources: ["src/not-text.ts"],
                sourcesContent: [42],
                names: [],
                mappings: "",
            })
        );
        fs.writeFileSync(
            path.join(assets, "conflicting-paths.js.map"),
            JSON.stringify({
                version: 3,
                sources: ["conflict", "conflict/file.ts"],
                sourcesContent: ["export const conflict = true;", "export const nested = true;"],
                names: [],
                mappings: "",
            })
        );
        fs.writeFileSync(
            path.join(assets, "safe.js.map"),
            JSON.stringify({
                version: 3,
                sources: ["src/safe.ts"],
                sourcesContent: ["export const safe = true;"],
                names: [],
                mappings: "",
            })
        );
        vi.spyOn(console, "log").mockImplementation(() => undefined);
        vi.spyOn(console, "warn").mockImplementation(() => undefined);

        await extractSourceMaps(assets, output);

        expect(fs.existsSync(path.join(root, "escape", "outside.ts"))).toBe(false);
        expect(fs.existsSync(path.join(output, "conflict"))).toBe(false);
        expect(fs.existsSync(path.join(output, "src", "safe.ts"))).toBe(true);
        expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("Skipped 1 unsafe source-map output path"));
        expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("Skipped 3 invalid source map"));
    });
});
