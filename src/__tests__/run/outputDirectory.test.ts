import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    clearRunOutputDirectory,
    getBatchTargetDirectoryName,
    reserveRunOutputDirectory,
    RunOutputDirectoryError,
} from "../../run/outputDirectory.js";

const temporaryDirectories: string[] = [];

const makeTemporaryDirectory = (): string => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "js-recon-output-test-"));
    temporaryDirectories.push(directory);
    return directory;
};

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

describe("run output directory reservation", () => {
    it("reserves the requested directory when it does not exist", () => {
        const root = makeTemporaryDirectory();
        const preferred = path.join(root, "output");

        const reserved = reserveRunOutputDirectory(preferred, false);

        expect(reserved).toMatchObject({ path: preferred, redirected: false, occupied: false });
        expect(fs.statSync(preferred).isDirectory()).toBe(true);
        reserved.release();
        reserved.release();
        expect(fs.readdirSync(preferred)).toEqual([".js-recon-output"]);
    });

    it("reuses an existing empty directory", () => {
        const root = makeTemporaryDirectory();
        const preferred = path.join(root, "output");
        fs.mkdirSync(preferred);

        const reserved = reserveRunOutputDirectory(preferred, false);
        expect(reserved).toMatchObject({
            path: preferred,
            redirected: false,
            occupied: false,
        });
        reserved.release();
    });

    it("atomically selects a non-destructive sibling for an occupied output", () => {
        const root = makeTemporaryDirectory();
        const preferred = path.join(root, "output");
        fs.mkdirSync(preferred);
        fs.writeFileSync(path.join(preferred, "sentinel"), "original");

        const reserved = reserveRunOutputDirectory(preferred, false);

        expect(reserved).toMatchObject({
            path: path.join(root, "output-2"),
            redirected: true,
            occupied: false,
        });
        expect(fs.readFileSync(path.join(preferred, "sentinel"), "utf8")).toBe("original");
        expect(fs.statSync(reserved.path).isDirectory()).toBe(true);
        reserved.release();
    });

    it("skips occupied siblings and leaves overwrite cleanup to the explicit caller", () => {
        const root = makeTemporaryDirectory();
        const preferred = path.join(root, "output");
        const second = path.join(root, "output-2");
        fs.mkdirSync(preferred);
        fs.mkdirSync(second);
        const ownership = reserveRunOutputDirectory(preferred, false);
        ownership.release();
        fs.writeFileSync(path.join(preferred, "sentinel"), "original");
        fs.writeFileSync(path.join(second, "sentinel"), "second");

        const redirected = reserveRunOutputDirectory(preferred, false);
        expect(redirected).toMatchObject({
            path: path.join(root, "output-3"),
            redirected: true,
            occupied: false,
        });
        const overwritten = reserveRunOutputDirectory(preferred, true);
        expect(overwritten).toMatchObject({
            path: preferred,
            redirected: false,
            occupied: true,
        });
        expect(fs.readFileSync(path.join(preferred, "sentinel"), "utf8")).toBe("original");
        redirected.release();
        overwritten.release();
    });

    it("rejects overwriting a file or the current working directory", () => {
        const root = makeTemporaryDirectory();
        const outputFile = path.join(root, "output");
        fs.writeFileSync(outputFile, "not a directory");

        expect(() => reserveRunOutputDirectory(outputFile, true)).toThrow(RunOutputDirectoryError);
        expect(() => reserveRunOutputDirectory(process.cwd(), true)).toThrow(/current working directory/);
    });

    it("refuses to overwrite broad protected directories", () => {
        expect(() => reserveRunOutputDirectory(os.homedir(), true)).toThrow(/protected directory/);
        expect(() => reserveRunOutputDirectory(path.dirname(process.cwd()), true)).toThrow(/protected directory/);
        expect(() => reserveRunOutputDirectory(os.tmpdir(), true)).toThrow(/protected directory/);
    });

    it("canonicalizes symlinked ancestors before allowing overwrite", () => {
        const root = makeTemporaryDirectory();
        const parentAlias = path.join(root, "parent-alias");
        fs.symlinkSync(path.dirname(process.cwd()), parentAlias, "dir");
        const aliasedWorkingDirectory = path.join(parentAlias, path.basename(process.cwd()));

        expect(() => reserveRunOutputDirectory(aliasedWorkingDirectory, true)).toThrow(/current working directory/);
    });

    it("does not allow concurrent runs to claim the same empty directory", () => {
        const root = makeTemporaryDirectory();
        const preferred = path.join(root, "output");

        const first = reserveRunOutputDirectory(preferred, false);
        const second = reserveRunOutputDirectory(preferred, false);

        expect(first.path).toBe(preferred);
        expect(second.path).toBe(path.join(root, "output-2"));
        first.release();
        second.release();
    });

    it("reclaims a well-formed reservation whose owning process is gone", () => {
        const root = makeTemporaryDirectory();
        const preferred = path.join(root, "output");
        const abandoned = reserveRunOutputDirectory(preferred, false);
        const lockPath = path.join(preferred, ".js-recon.lock");
        const metadata = JSON.parse(fs.readFileSync(lockPath, "utf8")) as Record<string, unknown>;
        fs.writeFileSync(lockPath, `${JSON.stringify({ ...metadata, pid: 2_147_483_647 })}\n`);

        const recovered = reserveRunOutputDirectory(preferred, false);

        expect(recovered.path).toBe(preferred);
        abandoned.release();
        recovered.release();
        expect(fs.readdirSync(preferred)).toEqual([".js-recon-output"]);
    });

    it("releases nested reservations and exits synchronously on SIGTERM", () => {
        const root = makeTemporaryDirectory();
        const output = reserveRunOutputDirectory(path.join(root, "output"), false);
        const target = reserveRunOutputDirectory(path.join(output.path, "target"), false);
        const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

        process.emit("SIGTERM", "SIGTERM");

        expect(exit).toHaveBeenCalledWith(143);
        expect(fs.existsSync(path.join(output.path, ".js-recon.lock"))).toBe(false);
        expect(fs.existsSync(path.join(target.path, ".js-recon.lock"))).toBe(false);
        target.release();
        output.release();
        exit.mockRestore();
    });

    it("does not follow an output-directory symbolic link", () => {
        const root = makeTemporaryDirectory();
        const linkedDirectory = path.join(root, "linked");
        const outputLink = path.join(root, "output");
        fs.mkdirSync(linkedDirectory);
        fs.writeFileSync(path.join(linkedDirectory, "sentinel"), "preserve me");
        fs.symlinkSync(linkedDirectory, outputLink, "dir");

        expect(() => reserveRunOutputDirectory(outputLink, true)).toThrow(/symbolic link/);
        expect(fs.readFileSync(path.join(linkedDirectory, "sentinel"), "utf8")).toBe("preserve me");
    });

    it("clears only a validated dedicated output directory", () => {
        const root = makeTemporaryDirectory();
        const output = path.join(root, "output");
        fs.mkdirSync(output);
        const reserved = reserveRunOutputDirectory(output, false);
        fs.mkdirSync(path.join(output, "nested"), { recursive: true });
        fs.writeFileSync(path.join(output, "nested", "result.json"), "{}");

        clearRunOutputDirectory(output);

        expect(fs.readdirSync(output).sort()).toEqual([".js-recon-output", ".js-recon.lock"].sort());
        reserved.release();
        expect(() => clearRunOutputDirectory(process.cwd())).toThrow(/current working directory/);
    });

    it("preserves an active reservation while clearing overwrite contents", () => {
        const root = makeTemporaryDirectory();
        const output = path.join(root, "output");
        fs.mkdirSync(output);
        const ownership = reserveRunOutputDirectory(output, false);
        ownership.release();
        fs.writeFileSync(path.join(output, "old-result.json"), "{}");
        const reserved = reserveRunOutputDirectory(output, true);

        clearRunOutputDirectory(output);

        expect(fs.existsSync(path.join(output, "old-result.json"))).toBe(false);
        expect(() => reserveRunOutputDirectory(output, true)).toThrow(/reserved by another run/);
        reserved.release();
        expect(fs.readdirSync(output)).toEqual([".js-recon-output"]);
    });

    it("never overwrites an occupied directory without a js-recon ownership marker", () => {
        const root = makeTemporaryDirectory();
        const output = path.join(root, "unowned");
        fs.mkdirSync(output);
        fs.writeFileSync(path.join(output, "sentinel"), "preserve me");

        expect(() => reserveRunOutputDirectory(output, true)).toThrow(/unowned directory/);
        expect(fs.readFileSync(path.join(output, "sentinel"), "utf8")).toBe("preserve me");
    });
});

describe("batch target directory names", () => {
    it("keeps the host layout unless multiple distinct targets share it", () => {
        expect(getBatchTargetDirectoryName("https://example.test/one", false)).toBe("example.test");

        const first = getBatchTargetDirectoryName("https://example.test/one", true);
        const second = getBatchTargetDirectoryName("https://example.test/two", true);
        expect(first).toMatch(/^example\.test--[a-f0-9]{12}$/);
        expect(second).toMatch(/^example\.test--[a-f0-9]{12}$/);
        expect(first).not.toBe(second);
        expect(getBatchTargetDirectoryName("https://example.test/one", true)).toBe(first);
    });
});
