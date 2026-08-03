import fs from "fs";
import os from "os";
import path from "path";
import prettier from "prettier";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DownloadQueue, type DownloadProgressSnapshot } from "../../lazyLoad/downloadQueue.js";
import { sanitizeOutputPathSegment, toOutputHost } from "../../lazyLoad/outputPath.js";
import { setScope } from "../../lazyLoad/globals.js";
import makeRequest, { withRequestSignal } from "../../utility/makeReq.js";

vi.mock("../../utility/makeReq.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../utility/makeReq.js")>();
    return { ...actual, default: vi.fn() };
});

vi.mock("prettier", () => ({
    default: {
        format: vi.fn(),
    },
}));

const mockedMakeRequest = vi.mocked(makeRequest);
const mockedFormat = vi.mocked(prettier.format);

let outputDir: string;

beforeEach(() => {
    outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "js-recon-download-queue-"));
    setScope(["*"]);
    mockedMakeRequest.mockReset();
    mockedFormat.mockReset();
});

afterEach(() => {
    setScope([]);
    fs.rmSync(outputDir, { recursive: true, force: true });
    vi.restoreAllMocks();
});

describe("DownloadQueue progress", () => {
    it("emits immutable snapshots when unique work is queued and completed", async () => {
        mockedMakeRequest.mockImplementation(async () => new Response("const ok = true;", { status: 200 }));
        mockedFormat.mockResolvedValue("const ok = true;\n");
        const snapshots: DownloadProgressSnapshot[] = [];
        const queue = new DownloadQueue(outputDir, 1, {
            compactOutput: true,
            onProgress: (progress) => snapshots.push(progress),
        });

        queue.push(["https://example.test/a.js", "https://example.test/a.js"]);
        const queuedSnapshot = snapshots[0];
        queue.push(["https://example.test/b.js"]);
        await queue.drain();

        expect(queuedSnapshot).toEqual({
            processed: 0,
            total: 1,
            downloaded: 0,
            failed: 0,
            ignored: 0,
            failures: {
                download: 0,
                invalidResponse: 0,
                format: 0,
                write: 0,
            },
        });
        expect(snapshots.at(-1)).toEqual({
            processed: 2,
            total: 2,
            downloaded: 2,
            failed: 0,
            ignored: 0,
            failures: {
                download: 0,
                invalidResponse: 0,
                format: 0,
                write: 0,
            },
        });
        expect(new Set(snapshots).size).toBe(snapshots.length);
        expect(Object.isFrozen(queuedSnapshot)).toBe(true);
        expect(Object.isFrozen(queuedSnapshot.failures)).toBe(true);
    });

    it("accounts for a formatting failure without printing the file or blocking later downloads", async () => {
        mockedMakeRequest.mockImplementation(
            async (url) =>
                new Response(url.endsWith("bad.js") ? "<!doctype html>" : "const ok = true;", { status: 200 })
        );
        mockedFormat.mockImplementation(async (source) => {
            if (source.includes("<!doctype html>")) throw new SyntaxError("Unexpected token (2:1)");
            return source;
        });
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const snapshots: DownloadProgressSnapshot[] = [];
        const queue = new DownloadQueue(outputDir, 1, {
            compactOutput: true,
            onProgress: (progress) => snapshots.push(progress),
        });

        queue.push(["https://example.test/bad.js", "https://example.test/good.js"]);
        await queue.drain();

        expect(snapshots.at(-1)).toEqual({
            processed: 2,
            total: 2,
            downloaded: 1,
            failed: 1,
            ignored: 0,
            failures: {
                download: 0,
                invalidResponse: 1,
                format: 0,
                write: 0,
            },
        });
        expect(errorSpy).not.toHaveBeenCalled();
        expect(fs.existsSync(path.join(outputDir, "example.test", "good.js"))).toBe(true);
    });

    it("prints one compact failure summary instead of per-file stack traces", async () => {
        mockedMakeRequest.mockImplementation(async () => new Response("<!doctype html>", { status: 200 }));
        mockedFormat.mockRejectedValue(new SyntaxError("Unexpected token (2:1)"));
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        const queue = new DownloadQueue(outputDir, 2, { compactOutput: true });

        queue.push(["https://example.test/one.js", "https://example.test/two.js", "https://example.test/three.js"]);
        await queue.drain();
        queue.printSummary();

        const output = warnSpy.mock.calls.flat().join("\n");
        expect(output).toContain("3 failed (0 download, 3 invalid response, 0 format, 0 write)");
        expect(output).not.toContain("one.js");
        expect(output).not.toContain("Unexpected token");
        expect(output).not.toContain("<!doctype");
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(errorSpy).not.toHaveBeenCalled();
        expect(logSpy).not.toHaveBeenCalled();
    });

    it("asks makeRequest to suppress its duplicate routine fetch errors in compact mode", async () => {
        mockedMakeRequest.mockResolvedValue(null);
        const queue = new DownloadQueue(outputDir, 1, { compactOutput: true });

        queue.push(["https://example.test/missing.js"]);
        await queue.drain();

        expect(mockedMakeRequest).toHaveBeenCalledWith("https://example.test/missing.js", {
            reportErrors: false,
        });
    });

    it("lets makeRequest own routine fetch diagnostics in non-compact mode without logging a duplicate", async () => {
        mockedMakeRequest.mockResolvedValue(null);
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const queue = new DownloadQueue(outputDir, 1);

        queue.push(["https://example.test/missing.js"]);
        await queue.drain();

        expect(mockedMakeRequest).toHaveBeenCalledWith("https://example.test/missing.js", {
            reportErrors: true,
        });
        expect(errorSpy).not.toHaveBeenCalled();
        expect(queue.progress.failures.download).toBe(1);
    });

    it("classifies response, formatting, and filesystem failures independently", async () => {
        mockedMakeRequest.mockImplementation(async (url) => {
            if (url.endsWith("status.js")) {
                return new Response("not found", { status: 404, headers: { "content-type": "text/plain" } });
            }
            if (url.endsWith("mime.js")) {
                return new Response("const hidden = true;", {
                    status: 200,
                    headers: { "content-type": "image/svg+xml" },
                });
            }
            if (url.endsWith("html.js")) {
                return new Response("\ufeff  <!doctype html><html></html>", {
                    status: 200,
                    headers: { "content-type": "text/plain" },
                });
            }
            if (url.endsWith("format.js")) {
                return new Response("invalid javascript", {
                    status: 200,
                    headers: { "content-type": "application/javascript" },
                });
            }
            return new Response("const write = true;", {
                status: 200,
                headers: { "content-type": "application/javascript" },
            });
        });
        mockedFormat.mockImplementation(async (source) => {
            if (source.includes("invalid javascript")) throw new SyntaxError("bad syntax");
            return source;
        });
        const realWriteFileSync = fs.writeFileSync.bind(fs);
        vi.spyOn(fs, "writeFileSync").mockImplementation((file, data, options) => {
            if (String(file).endsWith("write.js")) throw new Error("disk full");
            return realWriteFileSync(file, data, options);
        });
        const queue = new DownloadQueue(outputDir, 2, { compactOutput: true });

        queue.push([
            "https://example.test/status.js",
            "https://example.test/mime.js",
            "https://example.test/html.js",
            "https://example.test/format.js",
            "https://example.test/write.js",
        ]);
        await queue.drain();

        expect(mockedFormat).toHaveBeenCalledTimes(2);
        expect(queue.progress).toEqual({
            processed: 5,
            total: 5,
            downloaded: 0,
            failed: 5,
            ignored: 0,
            failures: {
                download: 0,
                invalidResponse: 3,
                format: 1,
                write: 1,
            },
        });
    });

    it("isolates a throwing observer so workers still start, drain, and record success", async () => {
        mockedMakeRequest.mockResolvedValue(new Response("const ok = true;", { status: 200 }));
        mockedFormat.mockResolvedValue("const ok = true;\n");
        const observer = vi.fn(() => {
            throw new Error("renderer closed");
        });
        const queue = new DownloadQueue(outputDir, 1, {
            compactOutput: true,
            onProgress: observer,
        });

        expect(() => queue.push(["https://example.test/ok.js"])).not.toThrow();
        await queue.drain();

        expect(observer).toHaveBeenCalledTimes(1);
        expect(queue.progress.downloaded).toBe(1);
        expect(queue.progress.processed).toBe(1);
    });

    it("nests the host by default, even when the output root already owns it", async () => {
        mockedMakeRequest.mockResolvedValue(new Response("const ok = true;", { status: 200 }));
        mockedFormat.mockResolvedValue("const ok = true;\n");
        const hostOutputDir = path.join(outputDir, "example.test");
        const queue = new DownloadQueue(hostOutputDir, 1, { compactOutput: true });

        queue.push(["https://example.test/assets/chunk.js"]);
        await queue.drain();

        expect(fs.existsSync(path.join(hostOutputDir, "assets", "chunk.js"))).toBe(false);
        expect(fs.existsSync(path.join(hostOutputDir, "example.test", "assets", "chunk.js"))).toBe(true);
    });

    it("does not duplicate the host when alreadyBatchTargetRoot is set and the output root already owns it", async () => {
        mockedMakeRequest.mockResolvedValue(new Response("const ok = true;", { status: 200 }));
        mockedFormat.mockResolvedValue("const ok = true;\n");
        const hostOutputDir = path.join(outputDir, "example.test");
        const queue = new DownloadQueue(hostOutputDir, 1, { compactOutput: true, alreadyBatchTargetRoot: true });

        queue.push(["https://example.test/assets/chunk.js"]);
        await queue.drain();

        expect(fs.existsSync(path.join(hostOutputDir, "assets", "chunk.js"))).toBe(true);
        expect(fs.existsSync(path.join(hostOutputDir, "example.test", "assets", "chunk.js"))).toBe(false);
    });

    it("matches raw scoped hosts with ports against their filesystem-safe output host", async () => {
        setScope(["localhost:3000"]);
        mockedMakeRequest.mockResolvedValue(new Response("const ok = true;", { status: 200 }));
        mockedFormat.mockResolvedValue("const ok = true;\n");
        const queue = new DownloadQueue(outputDir, 1, { compactOutput: true });

        queue.push(["http://localhost:3000/assets/chunk.js"]);
        await queue.drain();

        expect(queue.progress.downloaded).toBe(1);
        expect(fs.existsSync(path.join(outputDir, toOutputHost("localhost:3000"), "assets", "chunk.js"))).toBe(true);
    });

    it("does not authorize a filesystem-normalization collision as the scoped network host", async () => {
        setScope(["localhost:3000"]);
        const queue = new DownloadQueue(outputDir, 1, { compactOutput: true });

        queue.push(["http://localhost_3000/assets/chunk.js"]);
        await queue.drain();

        expect(queue.progress.ignored).toBe(1);
        expect(mockedMakeRequest).not.toHaveBeenCalled();
    });

    it("writes expression-like URL paths through sanitized directories and filenames", async () => {
        mockedMakeRequest.mockResolvedValue(new Response("const ok = true;", { status: 200 }));
        mockedFormat.mockResolvedValue("const ok = true;\n");
        const targetOutputDir = path.join(outputDir, "ss0x00.com");
        const queue = new DownloadQueue(targetOutputDir, 1, { compactOutput: true });
        const resourceUrl =
            "https://vercel.live/_next-live/feedback/'.concat(P.bd,'/_next-live/feedback/instrument.9431cd64d88c76a5bd6b.js";

        queue.push([resourceUrl]);
        await queue.drain();

        expect(
            fs.existsSync(
                path.join(
                    targetOutputDir,
                    "vercel.live",
                    "_next-live",
                    "feedback",
                    sanitizeOutputPathSegment("'.concat(P.bd,'"),
                    "_next-live",
                    "feedback",
                    "instrument.9431cd64d88c76a5bd6b.js"
                )
            )
        ).toBe(true);
    });

    it("uses the Vue parser for SFC URLs with a query string", async () => {
        mockedMakeRequest.mockResolvedValue(
            new Response("<template><div>ok</div></template>", {
                status: 200,
                headers: { "content-type": "text/html" },
            })
        );
        mockedFormat.mockResolvedValue("<template><div>ok</div></template>\n");
        const queue = new DownloadQueue(outputDir, 1, { compactOutput: true });

        queue.push(["https://example.test/components/Card.vue?v=123"]);
        await queue.drain();

        expect(mockedFormat).toHaveBeenCalledWith(expect.any(String), { parser: "vue" });
        expect(queue.progress.downloaded).toBe(1);
    });

    it("reconciles every queued URL across success, failure, and ignored outcomes", async () => {
        setScope(["example.test"]);
        mockedMakeRequest.mockImplementation(async (url) => {
            if (url.endsWith("missing.js")) return null;
            return new Response(url.endsWith("invalid.js") ? "not javascript" : "const ok = true;", {
                status: 200,
            });
        });
        mockedFormat.mockImplementation(async (source) => {
            if (source.includes("not javascript")) throw new SyntaxError("invalid chunk");
            return source;
        });
        const snapshots: DownloadProgressSnapshot[] = [];
        const queue = new DownloadQueue(outputDir, 3, {
            compactOutput: true,
            onProgress: (progress) => snapshots.push(progress),
        });

        queue.push([
            "https://example.test/good.js",
            "https://example.test/invalid.js",
            "https://example.test/missing.js",
            "https://example.test/styles.css",
            "https://outside.test/scoped.js",
        ]);
        await queue.drain();

        const finalProgress = snapshots.at(-1)!;
        expect(finalProgress).toEqual({
            processed: 5,
            total: 5,
            downloaded: 1,
            failed: 2,
            ignored: 2,
            failures: {
                download: 1,
                invalidResponse: 0,
                format: 1,
                write: 0,
            },
        });
        expect(finalProgress.processed).toBe(finalProgress.downloaded + finalProgress.failed + finalProgress.ignored);
    });

    it("does not format or write a response that arrives after scoped cancellation", async () => {
        let resolveResponse!: (response: Response) => void;
        mockedMakeRequest.mockImplementationOnce(
            () =>
                new Promise<Response>((resolve) => {
                    resolveResponse = resolve;
                })
        );
        const controller = new AbortController();
        const queue = new DownloadQueue(outputDir, 1, { compactOutput: true });

        await withRequestSignal(controller.signal, async () => {
            queue.push(["https://example.test/late.js"]);
            await vi.waitFor(() => expect(mockedMakeRequest).toHaveBeenCalledTimes(1));
            controller.abort();
            resolveResponse(new Response("const late = true;", { status: 200 }));
            await queue.drain();
        });

        expect(mockedFormat).not.toHaveBeenCalled();
        expect(queue.progress).toMatchObject({ processed: 1, downloaded: 0, failed: 0, ignored: 1 });
        expect(fs.existsSync(path.join(outputDir, "example.test", "late.js"))).toBe(false);
    });
});
