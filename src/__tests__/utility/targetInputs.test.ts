import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectTargetInput, resolveTargetInputs, TargetInputError } from "../../utility/targetInputs.js";

const temporaryDirectories: string[] = [];

const makeTemporaryDirectory = (): string => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "js-recon-targets-test-"));
    temporaryDirectories.push(directory);
    return directory;
};

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

describe("target input collection", () => {
    it("collects repeated -u values without mutating the previous array", () => {
        const previous = Object.freeze(["https://one.example.test"]);

        const collected = collectTargetInput("https://two.example.test", previous);

        expect(collected).toEqual(["https://one.example.test", "https://two.example.test"]);
        expect(previous).toEqual(["https://one.example.test"]);
        expect(collectTargetInput("https://first.example.test", undefined)).toEqual(["https://first.example.test"]);
    });
});

describe("target input resolution", () => {
    it("resolves one HTTP(S) URL as a non-batch target", () => {
        expect(resolveTargetInputs("https://one.example.test/path")).toEqual({
            targets: ["https://one.example.test/path"],
            isBatch: false,
        });
    });

    it("resolves comma-separated URLs while preserving commas inside a single URL", () => {
        expect(resolveTargetInputs("https://one.example.test/a,https://two.example.test/b")).toEqual({
            targets: ["https://one.example.test/a", "https://two.example.test/b"],
            isBatch: true,
        });
        expect(resolveTargetInputs("https://one.example.test/a,b?items=1,2")).toEqual({
            targets: ["https://one.example.test/a,b?items=1,2"],
            isBatch: false,
        });
    });

    it("rejects a comma list when a later HTTP(S) target is malformed", () => {
        expect(() => resolveTargetInputs("https://one.example.test/a,https://bad value")).toThrow(/Invalid target/);
    });

    it("reads, trims, validates, and deduplicates a target file", () => {
        const root = makeTemporaryDirectory();
        const targetsPath = path.join(root, "targets.txt");
        fs.writeFileSync(
            targetsPath,
            [
                "  https://one.example.test/path  \r",
                "",
                "https://two.example.test/",
                "https://one.example.test/path",
                "",
            ].join("\n")
        );

        expect(resolveTargetInputs(targetsPath)).toEqual({
            targets: ["https://one.example.test/path", "https://two.example.test/"],
            isBatch: true,
        });
    });

    it("combines repeated, comma-separated, and file inputs in stable order", () => {
        const root = makeTemporaryDirectory();
        const targetsPath = path.join(root, "targets.txt");
        fs.writeFileSync(targetsPath, "https://three.example.test\nhttps://one.example.test\n");

        expect(
            resolveTargetInputs([
                "https://one.example.test",
                "https://two.example.test,https://three.example.test",
                targetsPath,
            ])
        ).toEqual({
            targets: ["https://one.example.test", "https://two.example.test", "https://three.example.test"],
            isBatch: true,
        });
    });

    it("rejects directories, empty files, and non-HTTP protocols", () => {
        const root = makeTemporaryDirectory();
        const emptyPath = path.join(root, "empty.txt");
        fs.writeFileSync(emptyPath, " \n\r\n");

        expect(() => resolveTargetInputs(root)).toThrow(/regular file/);
        expect(() => resolveTargetInputs(emptyPath)).toThrow(/does not contain any targets/);
        expect(() => resolveTargetInputs("ftp://files.example.test/archive")).toThrow(TargetInputError);
        expect(() => resolveTargetInputs("not-a-url")).toThrow(/Invalid target/);
    });

    it("skips a malformed line in a target file instead of aborting the whole batch", () => {
        const root = makeTemporaryDirectory();
        const targetsPath = path.join(root, "targets.txt");
        fs.writeFileSync(
            targetsPath,
            ["https://example1.invalid", "not-a-valid-target-line", "https://example2.invalid"].join("\n")
        );

        expect(resolveTargetInputs(targetsPath)).toEqual({
            targets: ["https://example1.invalid", "https://example2.invalid"],
            isBatch: true,
        });
    });

    it("still fails when every line in a target file is malformed", () => {
        const root = makeTemporaryDirectory();
        const targetsPath = path.join(root, "all-invalid.txt");
        fs.writeFileSync(targetsPath, "not-a-valid-target-line\nalso-not-valid\n");

        expect(() => resolveTargetInputs(targetsPath)).toThrow(/does not contain any targets/);
    });

    it("rejects target files larger than the bounded input limit", () => {
        const root = makeTemporaryDirectory();
        const targetsPath = path.join(root, "too-many-targets.txt");
        fs.writeFileSync(targetsPath, "x".repeat(1024 * 1024 + 1));

        expect(() => resolveTargetInputs(targetsPath)).toThrow(/size limit/);
    });

    it("rejects symbolic-link target files", () => {
        const root = makeTemporaryDirectory();
        const targetsPath = path.join(root, "targets.txt");
        const targetsLink = path.join(root, "targets-link.txt");
        fs.writeFileSync(targetsPath, "https://one.example.test\n");
        fs.symlinkSync(targetsPath, targetsLink);

        expect(() => resolveTargetInputs(targetsLink)).toThrow(/symbolic link/);
    });

    it("rejects URL credentials without echoing them in the error", () => {
        let thrown: unknown;
        try {
            resolveTargetInputs("https://operator:super-secret@example.test/path");
        } catch (error) {
            thrown = error;
        }

        expect(thrown).toBeInstanceOf(TargetInputError);
        expect((thrown as Error).message).toMatch(/must not include credentials/);
        expect((thrown as Error).message).not.toContain("super-secret");
    });
});
