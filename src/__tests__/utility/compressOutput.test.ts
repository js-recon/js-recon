import fs from "fs";
import os from "os";
import path from "path";
import zlib from "zlib";
import * as tar from "tar";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { compressDirectory, COMPRESSION_TYPES, validateCompressionType } from "../../utility/compressOutput.js";

const FILES: Record<string, string> = {
    "example.com/_next/static/chunks/main.js": "console.log('main');\n".repeat(50),
    "example.com/index.js": "export const a = 1;\n",
    "cdn.example.com/app.mjs": "export default 2;\n",
};

let tmp: string;
let dir: string;

const makeOutput = (): void => {
    for (const [rel, body] of Object.entries(FILES)) {
        fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
        fs.writeFileSync(path.join(dir, rel), body);
    }
    fs.writeFileSync(path.join(dir, ".js-recon-output"), "marker\n");
    fs.writeFileSync(path.join(dir, ".js-recon.lock"), "{}");
};

/** Reads a zip written by compressDirectory back into {name: content}. */
const readZip = (buf: Buffer): Record<string, string> => {
    const end = buf.length - 22;
    expect(buf.readUInt32LE(end)).toBe(0x06054b50);
    const count = buf.readUInt16LE(end + 10);
    let p = buf.readUInt32LE(end + 16);
    const out: Record<string, string> = {};
    for (let i = 0; i < count; i++) {
        expect(buf.readUInt32LE(p)).toBe(0x02014b50);
        const crc = buf.readUInt32LE(p + 16);
        const csize = buf.readUInt32LE(p + 20);
        const nlen = buf.readUInt16LE(p + 28);
        const local = buf.readUInt32LE(p + 42);
        const name = buf.subarray(p + 46, p + 46 + nlen).toString();
        const dataStart = local + 30 + buf.readUInt16LE(local + 26);
        const data = zlib.inflateRawSync(buf.subarray(dataStart, dataStart + csize));
        expect(zlib.crc32(data)).toBe(crc);
        out[name] = data.toString();
        p += 46 + nlen;
    }
    return out;
};

beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jsr-compress-"));
    dir = path.join(tmp, "output");
    makeOutput();
    process.exitCode = undefined;
});

afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    process.exitCode = undefined;
    vi.restoreAllMocks();
});

describe("compressDirectory", () => {
    for (const type of ["tar", "gzip", "brotli", "zstd"]) {
        it(`writes a ${type} archive that round-trips and removes the directory`, () => {
            const archive = compressDirectory(dir, type);
            expect(archive).toBe(dir + COMPRESSION_TYPES[type]);
            expect(fs.existsSync(dir)).toBe(false);
            const extracted = path.join(tmp, "x");
            fs.mkdirSync(extracted);
            tar.x({ file: archive!, cwd: extracted, sync: true });
            for (const [rel, body] of Object.entries(FILES)) {
                expect(fs.readFileSync(path.join(extracted, "output", rel), "utf8")).toBe(body);
            }
            expect(fs.existsSync(path.join(extracted, "output", ".js-recon-output"))).toBe(false);
            expect(fs.existsSync(path.join(extracted, "output", ".js-recon.lock"))).toBe(false);
        });
    }

    it("writes a zip archive that round-trips and removes the directory", () => {
        const archive = compressDirectory(dir, "zip");
        expect(archive).toBe(dir + ".zip");
        expect(fs.existsSync(dir)).toBe(false);
        const entries = readZip(fs.readFileSync(archive!));
        expect(entries).toEqual(Object.fromEntries(Object.entries(FILES).map(([k, v]) => [`output/${k}`, v])));
    });

    it("keeps the directory and sets exit code 42 when the archive can't be written", () => {
        vi.spyOn(console, "error").mockImplementation(() => {});
        fs.mkdirSync(dir + ".tar.gz"); // a directory where the archive file should go
        expect(compressDirectory(dir, "gzip")).toBeNull();
        expect(fs.existsSync(path.join(dir, "example.com/index.js"))).toBe(true);
        expect(process.exitCode).toBe(42);
    });

    it("returns null for a missing directory", () => {
        expect(compressDirectory(path.join(tmp, "nope"), "zip")).toBeNull();
        expect(process.exitCode).toBeUndefined();
    });
});

describe("compressDirectory safety", () => {
    const tarEntries = (archive: string): tar.ReadEntry[] => {
        const entries: tar.ReadEntry[] = [];
        tar.t({ file: archive, sync: true, onReadEntry: (e) => entries.push(e) } as any);
        return entries;
    };

    it("leaves symlinks out of tar and zip archives", () => {
        const outside = path.join(tmp, "secret.txt");
        fs.writeFileSync(outside, "outside");
        fs.symlinkSync(outside, path.join(dir, "example.com/link.js"));
        fs.symlinkSync(tmp, path.join(dir, "example.com/dirlink"));
        const tgz = compressDirectory(dir, "gzip")!;
        const names = tarEntries(tgz).map((e) => e.path);
        expect(names.some((n) => n.includes("link"))).toBe(false);
        expect(tarEntries(tgz).every((e) => e.type === "File" || e.type === "Directory")).toBe(true);
        expect(fs.readFileSync(outside, "utf8")).toBe("outside"); // deleting the dir didn't follow the link

        fs.rmSync(tgz);
        makeOutput();
        fs.symlinkSync(outside, path.join(dir, "example.com/link.js"));
        const zip = compressDirectory(dir, "zip")!;
        expect(Object.keys(readZip(fs.readFileSync(zip))).some((n) => n.includes("link"))).toBe(false);
    });

    it("stores hard-linked files as full copies, not link entries", () => {
        fs.linkSync(path.join(dir, "example.com/index.js"), path.join(dir, "example.com/copy.js"));
        const entries = tarEntries(compressDirectory(dir, "tar")!);
        expect(entries.some((e) => e.type === "Link")).toBe(false);
        expect(entries.find((e) => e.path === "output/example.com/copy.js")?.size).toBe(
            FILES["example.com/index.js"].length
        );
    });

    it("never writes absolute or parent-relative member names", () => {
        const all = [...tarEntries(compressDirectory(dir, "zstd")!).map((e) => e.path)];
        fs.rmSync(dir + ".tar.zst");
        makeOutput();
        all.push(...Object.keys(readZip(fs.readFileSync(compressDirectory(dir, "zip")!))));
        for (const n of all) {
            expect(n.startsWith("output")).toBe(true);
            expect(n.split("/")).not.toContain("..");
        }
    });

    it("stores plain modes without setuid/setgid/sticky or world-writable bits, and no owner", () => {
        fs.chmodSync(path.join(dir, "example.com/index.js"), 0o6777);
        const entries = tarEntries(compressDirectory(dir, "tar")!);
        for (const e of entries) {
            expect(e.mode).toBe(e.type === "Directory" ? 0o755 : 0o644);
            expect(e.uid ?? 0).toBe(0);
        }
    });

    it("creates the archive owner-only", () => {
        const archive = compressDirectory(dir, "brotli")!;
        expect(fs.statSync(archive).mode & 0o777).toBe(0o600);
    });

    it("never overwrites an existing file or symlink at the archive path", () => {
        vi.spyOn(console, "error").mockImplementation(() => {});
        const victim = path.join(tmp, "victim.txt");
        fs.writeFileSync(victim, "keep");
        fs.symlinkSync(victim, dir + ".zip");
        expect(compressDirectory(dir, "zip")).toBeNull();
        expect(fs.readFileSync(victim, "utf8")).toBe("keep");
        expect(fs.lstatSync(dir + ".zip").isSymbolicLink()).toBe(true);
        fs.writeFileSync(dir + ".tar", "existing");
        expect(compressDirectory(dir, "tar")).toBeNull();
        expect(fs.readFileSync(dir + ".tar", "utf8")).toBe("existing");
        expect(fs.existsSync(path.join(dir, "example.com/index.js"))).toBe(true);
        expect(process.exitCode).toBe(42);
    });

    it("refuses a symlinked output directory and leaves its target alone", () => {
        vi.spyOn(console, "error").mockImplementation(() => {});
        const link = path.join(tmp, "linked");
        fs.symlinkSync(dir, link);
        expect(compressDirectory(link, "gzip")).toBeNull();
        expect(fs.existsSync(link + ".tar.gz")).toBe(false);
        expect(fs.existsSync(path.join(dir, "example.com/index.js"))).toBe(true);
        expect(process.exitCode).toBe(42);
    });
});

describe("validateCompressionType", () => {
    it("accepts every known type and undefined", () => {
        const exit = vi.spyOn(process, "exit").mockImplementation((() => {}) as any);
        for (const t of [undefined, ...Object.keys(COMPRESSION_TYPES)]) validateCompressionType(t);
        expect(exit).not.toHaveBeenCalled();
    });

    it("exits 42 on an unknown type", () => {
        vi.spyOn(console, "error").mockImplementation(() => {});
        const exit = vi.spyOn(process, "exit").mockImplementation((() => {}) as any);
        validateCompressionType("rar");
        expect(exit).toHaveBeenCalledWith(42);
    });
});
