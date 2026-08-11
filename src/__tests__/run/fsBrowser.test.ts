import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { resolveSafePath, buildFileTree } from "../../run/dashboard/fsBrowser.js";

describe("resolveSafePath", () => {
    const base = "/tmp/js-recon-test-target";

    it("resolves a plain relative path within the base dir", () => {
        expect(resolveSafePath(base, "mapped.json")).toBe(path.resolve(base, "mapped.json"));
    });

    it("resolves a nested relative path within the base dir", () => {
        expect(resolveSafePath(base, "static/js/main.js")).toBe(path.resolve(base, "static/js/main.js"));
    });

    it("rejects a path that escapes the base dir via ../", () => {
        expect(resolveSafePath(base, "../../etc/passwd")).toBeNull();
    });

    it("rejects an absolute path outside the base dir", () => {
        expect(resolveSafePath(base, "/etc/passwd")).toBeNull();
    });

    it("allows the base dir itself (empty/dot path)", () => {
        expect(resolveSafePath(base, "")).toBe(path.resolve(base));
        expect(resolveSafePath(base, ".")).toBe(path.resolve(base));
    });

    it("rejects a sibling directory that merely shares the base dir as a string prefix", () => {
        // e.g. base = /tmp/output/example.com, a naive startsWith() check without the
        // path.sep guard would let "/tmp/output/example.com-evil" pass.
        expect(resolveSafePath(base, `../${path.basename(base)}-evil/secret`)).toBeNull();
    });
});

describe("buildFileTree", () => {
    let dir: string;

    beforeAll(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "js-recon-filetree-"));
        fs.mkdirSync(path.join(dir, "static", "js"), { recursive: true });
        fs.writeFileSync(path.join(dir, "mapped.json"), "{}");
        fs.writeFileSync(path.join(dir, "static", "js", "main.js"), "// js");
    });

    afterAll(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it("returns [] for a non-existent directory", () => {
        expect(buildFileTree(path.join(dir, "does-not-exist"))).toEqual([]);
    });

    it("lists directories before files, sorted by name", () => {
        const tree = buildFileTree(dir);
        expect(tree[0]).toMatchObject({ name: "static", type: "directory" });
        expect(tree[1]).toMatchObject({ name: "mapped.json", type: "file" });
    });

    it("recurses into subdirectories with relative paths", () => {
        const tree = buildFileTree(dir);
        const staticDir = tree.find((e) => e.name === "static")!;
        const jsDir = staticDir.children!.find((e) => e.name === "js")!;
        expect(jsDir.children).toEqual([{ name: "main.js", type: "file", path: "static/js/main.js" }]);
    });
});
