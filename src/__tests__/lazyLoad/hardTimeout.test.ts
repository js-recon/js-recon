import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as globals from "../../utility/globals.js";

const harness = vi.hoisted(() => ({
    frameworkDetect: vi.fn(),
    crawl: vi.fn<() => Promise<void>>(),
    stop: vi.fn(),
    drain: vi.fn(async () => undefined),
    printSummary: vi.fn(),
    push: vi.fn(),
    reactGetScriptTags: vi.fn(),
    reactWebpackChunkPaths: vi.fn(),
    reactFollowImports: vi.fn(),
    reactSourcemapUrls: vi.fn(),
    extractSourceMaps: vi.fn(async () => undefined),
}));

vi.mock("../../lazyLoad/techDetect/index.js", () => ({
    default: harness.frameworkDetect,
}));

vi.mock("../../lazyLoad/react/react_getScriptTags.js", () => ({ default: harness.reactGetScriptTags }));
vi.mock("../../lazyLoad/react/react_webpackChunkPaths.js", () => ({ default: harness.reactWebpackChunkPaths }));
vi.mock("../../lazyLoad/react/react_followImports.js", () => ({ default: harness.reactFollowImports }));
vi.mock("../../lazyLoad/react/react_sourcemapUrls.js", () => ({ default: harness.reactSourcemapUrls }));
vi.mock("../../lazyLoad/downloadLoadedJsUtil.js", () => ({ default: vi.fn(async () => []) }));

vi.mock("../../lazyLoad/next_js/NextJsCrawler.js", () => ({
    default: class MockNextJsCrawler {
        techniqueEfficiencyMapping = {};
        crawl = harness.crawl;
        stop = harness.stop;
    },
}));

vi.mock("../../lazyLoad/downloadQueue.js", () => ({
    DownloadQueue: class MockDownloadQueue {
        progress = {
            processed: 0,
            total: 0,
            downloaded: 0,
            failed: 0,
            ignored: 0,
            failures: { download: 0, invalidResponse: 0, format: 0, write: 0 },
        };
        push = harness.push;
        drain = harness.drain;
        printSummary = harness.printSummary;
    },
}));

vi.mock("../../sourcemaps/index.js", () => ({
    extractSourceMaps: harness.extractSourceMaps,
}));

import lazyLoad from "../../lazyLoad/index.js";

beforeEach(() => {
    globals.setDisableCache(true);
    harness.frameworkDetect.mockReset();
    harness.frameworkDetect.mockResolvedValue({ name: "next", evidence: "test" });
    harness.crawl.mockReset();
    harness.crawl.mockResolvedValue(undefined);
    harness.stop.mockReset();
    harness.drain.mockClear();
    harness.printSummary.mockClear();
    harness.push.mockReset();
    harness.reactGetScriptTags.mockReset();
    harness.reactGetScriptTags.mockResolvedValue([]);
    harness.reactWebpackChunkPaths.mockReset();
    harness.reactWebpackChunkPaths.mockResolvedValue([]);
    harness.reactFollowImports.mockReset();
    harness.reactFollowImports.mockResolvedValue([]);
    harness.reactSourcemapUrls.mockReset();
    harness.reactSourcemapUrls.mockResolvedValue([]);
    harness.extractSourceMaps.mockClear();
});

afterEach(() => {
    globals.setDisableCache(false);
    vi.restoreAllMocks();
});

describe("lazyLoad hard timeout", () => {
    it("accepts IPv6 input URLs that the URL parser recognizes", async () => {
        vi.spyOn(process, "exit").mockImplementation((code) => {
            throw new Error(`unexpected process.exit(${code})`);
        });
        await lazyLoad(
            "http://[::1]:3000",
            "/tmp/js-recon-ipv6-input-test",
            true,
            [],
            1,
            false,
            "",
            false,
            false,
            "sourcemaps",
            false,
            "research.json",
            1,
            2,
            0,
            200,
            [],
            [],
            10
        );

        expect(harness.frameworkDetect).toHaveBeenCalledWith("http://[::1]:3000", expect.any(AbortSignal));
    });

    it("runs framework detection only once per input URL", async () => {
        await lazyLoad(
            "https://example.test",
            "/tmp/js-recon-single-detection-test",
            true,
            [],
            1,
            false,
            "",
            false,
            false,
            "sourcemaps",
            false,
            "research.json",
            1,
            2,
            0,
            200,
            [],
            [],
            10
        );

        expect(harness.frameworkDetect).toHaveBeenCalledTimes(1);
    });

    it("aborts and awaits framework detection when its timeout expires", async () => {
        globals.setTech("react");
        let capturedSignal: AbortSignal | undefined;
        let detectorSettled = false;
        harness.frameworkDetect.mockImplementationOnce((_url: string, signal?: AbortSignal) => {
            capturedSignal = signal;
            return new Promise<null>((resolve) => {
                signal?.addEventListener(
                    "abort",
                    () => {
                        detectorSettled = true;
                        resolve(null);
                    },
                    { once: true }
                );
            });
        });

        await lazyLoad(
            "https://example.test",
            "/tmp/js-recon-detection-timeout-test",
            true,
            [],
            1,
            false,
            "",
            false,
            false,
            "sourcemaps",
            false,
            "research.json",
            1,
            2,
            0,
            200,
            [],
            [],
            10
        );

        expect(capturedSignal?.aborted).toBe(true);
        expect(detectorSettled).toBe(true);
        expect(globals.getTech()).toBe("");
    });

    it("clears a previous target's technology when the module timeout interrupts detection", async () => {
        globals.setTech("react");
        harness.frameworkDetect.mockImplementationOnce(
            (_url: string, signal?: AbortSignal) =>
                new Promise<null>((resolve) => {
                    signal?.addEventListener("abort", () => resolve(null), { once: true });
                })
        );

        await lazyLoad(
            "https://timeout.example.test",
            "/tmp/js-recon-stale-tech-timeout-test",
            true,
            [],
            1,
            false,
            "",
            false,
            false,
            "sourcemaps",
            false,
            "research.json",
            1,
            2,
            10,
            200,
            [],
            [],
            0
        );

        expect(globals.getTech()).toBe("");
    });

    it("requests cancellation but does not resolve while framework discovery is still running", async () => {
        let resolveCrawl!: () => void;
        harness.crawl.mockImplementationOnce(
            () =>
                new Promise<void>((resolve) => {
                    resolveCrawl = resolve;
                })
        );
        let resolved = false;

        const result = lazyLoad(
            "https://example.test",
            "/tmp/js-recon-timeout-test",
            true,
            [],
            1,
            false,
            "",
            false,
            false,
            "sourcemaps",
            false,
            "research.json",
            1,
            2,
            10,
            200,
            [],
            [],
            0
        ).then(() => {
            resolved = true;
        });

        await new Promise((resolve) => setTimeout(resolve, 30));

        expect(harness.stop).toHaveBeenCalledTimes(1);
        expect(resolved).toBe(false);

        resolveCrawl();
        await result;
        expect(resolved).toBe(true);
    });

    it("does not queue seed or webpack work that resolves after the timeout", async () => {
        harness.frameworkDetect.mockResolvedValue({ name: "react", evidence: "test" });
        let resolveScripts!: (scripts: string[]) => void;
        harness.reactGetScriptTags.mockImplementationOnce(
            () =>
                new Promise<string[]>((resolve) => {
                    resolveScripts = resolve;
                })
        );

        const result = lazyLoad(
            "https://example.test",
            "/tmp/js-recon-react-timeout-test",
            true,
            [],
            1,
            false,
            "",
            false,
            false,
            "sourcemaps",
            false,
            "research.json",
            1,
            2,
            10,
            200,
            [],
            [],
            0
        );

        await new Promise((resolve) => setTimeout(resolve, 30));
        resolveScripts(["https://example.test/late-seed.js"]);
        await result;

        expect(harness.push).not.toHaveBeenCalled();
        expect(harness.reactWebpackChunkPaths).not.toHaveBeenCalled();
    });

    it("drains seed downloads when an external phase skip lands during webpack discovery", async () => {
        harness.frameworkDetect.mockResolvedValue({ name: "react", evidence: "test" });
        harness.reactGetScriptTags.mockResolvedValue(["https://example.test/seed.js"]);
        let resolveWebpack!: (scripts: string[]) => void;
        harness.reactWebpackChunkPaths.mockImplementationOnce(
            () =>
                new Promise<string[]>((resolve) => {
                    resolveWebpack = resolve;
                })
        );
        const controller = new AbortController();

        const result = lazyLoad(
            "https://example.test",
            "/tmp/js-recon-react-skip-test",
            true,
            [],
            1,
            false,
            "",
            false,
            false,
            "sourcemaps",
            false,
            "research.json",
            1,
            2,
            0,
            200,
            [],
            [],
            0,
            controller.signal
        );

        await vi.waitFor(() => expect(harness.reactWebpackChunkPaths).toHaveBeenCalledTimes(1));
        controller.abort();
        resolveWebpack([]);
        await result;

        expect(harness.push.mock.calls.flat(2)).toContain("https://example.test/seed.js");
        expect(harness.drain).toHaveBeenCalledTimes(1);
    });

    it("drops import discoveries that arrive after the timeout", async () => {
        harness.frameworkDetect.mockResolvedValue({ name: "react", evidence: "test" });
        harness.reactGetScriptTags.mockResolvedValue(["https://example.test/seed.js"]);
        harness.reactWebpackChunkPaths.mockResolvedValue(["https://example.test/chunk.js"]);
        let resolveImports!: (scripts: string[]) => void;
        harness.reactFollowImports.mockImplementationOnce(
            () =>
                new Promise<string[]>((resolve) => {
                    resolveImports = resolve;
                })
        );

        const result = lazyLoad(
            "https://example.test",
            "/tmp/js-recon-react-import-timeout-test",
            true,
            [],
            1,
            false,
            "",
            false,
            false,
            "sourcemaps",
            false,
            "research.json",
            1,
            2,
            10,
            200,
            [],
            [],
            0
        );

        await vi.waitFor(() => expect(harness.reactFollowImports).toHaveBeenCalledTimes(1));
        await new Promise((resolve) => setTimeout(resolve, 30));
        resolveImports(["https://example.test/late-import.js"]);
        await result;

        expect(harness.push.mock.calls.flat(2)).not.toContain("https://example.test/late-import.js");
        expect(harness.reactSourcemapUrls).not.toHaveBeenCalled();
    });

    it("does not start source-map extraction after cancellation during queue drain", async () => {
        harness.frameworkDetect.mockResolvedValue({ name: "react", evidence: "test" });
        let resolveDrain!: () => void;
        harness.drain.mockImplementationOnce(
            () =>
                new Promise<void>((resolve) => {
                    resolveDrain = resolve;
                })
        );
        const controller = new AbortController();

        const result = lazyLoad(
            "https://example.test",
            "/tmp/js-recon-react-cancelled-post-processing-test",
            true,
            [],
            1,
            false,
            "",
            false,
            false,
            "sourcemaps",
            false,
            "research.json",
            1,
            2,
            0,
            200,
            [],
            [],
            0,
            controller.signal
        );

        await vi.waitFor(() => expect(harness.drain).toHaveBeenCalledTimes(1));
        controller.abort();
        resolveDrain();
        await result;

        expect(harness.extractSourceMaps).not.toHaveBeenCalled();
    });
});
