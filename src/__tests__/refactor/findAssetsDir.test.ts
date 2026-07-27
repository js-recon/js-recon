import { describe, it, expect, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { findAssetsDir } from "../../refactor/index.js";

describe("findAssetsDir", () => {
    const tmpDirs: string[] = [];

    afterEach(() => {
        for (const dir of tmpDirs.splice(0)) {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("returns the assets dir sitting directly next to mapped.json", () => {
        const hostDir = fs.mkdtempSync(path.join(os.tmpdir(), "jsr-assets-"));
        tmpDirs.push(hostDir);
        const assetsDir = path.join(hostDir, "assets");
        fs.mkdirSync(assetsDir);
        const mappedJsonPath = path.join(hostDir, "mapped.json");
        fs.writeFileSync(mappedJsonPath, "{}");

        expect(findAssetsDir(mappedJsonPath)).toBe(assetsDir);
    });

    it("returns null when no assets dir exists next to mapped.json", () => {
        const hostDir = fs.mkdtempSync(path.join(os.tmpdir(), "jsr-assets-"));
        tmpDirs.push(hostDir);
        const mappedJsonPath = path.join(hostDir, "mapped.json");
        fs.writeFileSync(mappedJsonPath, "{}");

        expect(findAssetsDir(mappedJsonPath)).toBeNull();
    });

    it("resolves a relative mappedJsonPath against the host dir, not an output/<hostname> subpath", () => {
        const hostDir = fs.mkdtempSync(path.join(os.tmpdir(), "jsr-assets-"));
        tmpDirs.push(hostDir);
        fs.mkdirSync(path.join(hostDir, "assets"));
        fs.mkdirSync(path.join(hostDir, "output"), { recursive: true });
        const mappedJsonPath = path.join(hostDir, "mapped.json");
        fs.writeFileSync(mappedJsonPath, "{}");

        expect(findAssetsDir(mappedJsonPath)).toBe(path.join(hostDir, "assets"));
    });

    it("uses an explicit assetsDir override when mapped.json lives elsewhere (e.g. cwd)", () => {
        const hostDir = fs.mkdtempSync(path.join(os.tmpdir(), "jsr-assets-"));
        tmpDirs.push(hostDir);
        const assetsDir = path.join(hostDir, "assets");
        fs.mkdirSync(assetsDir);
        const mappedJsonDir = fs.mkdtempSync(path.join(os.tmpdir(), "jsr-mapped-"));
        tmpDirs.push(mappedJsonDir);
        const mappedJsonPath = path.join(mappedJsonDir, "mapped.json");
        fs.writeFileSync(mappedJsonPath, "{}");

        expect(findAssetsDir(mappedJsonPath, assetsDir)).toBe(assetsDir);
    });

    it("returns null when the explicit assetsDir override does not exist", () => {
        const mappedJsonDir = fs.mkdtempSync(path.join(os.tmpdir(), "jsr-mapped-"));
        tmpDirs.push(mappedJsonDir);
        const mappedJsonPath = path.join(mappedJsonDir, "mapped.json");
        fs.writeFileSync(mappedJsonPath, "{}");

        expect(findAssetsDir(mappedJsonPath, path.join(mappedJsonDir, "does-not-exist"))).toBeNull();
    });
});
