import fs from "fs";
import os from "os";
import path from "path";
import prettier from "prettier";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import downloadFiles from "../../lazyLoad/downloadFilesUtil.js";
import { getSanitizedAssetFilename } from "../../lazyLoad/outputPath.js";
import { setMaxReqQueue, setScope } from "../../lazyLoad/globals.js";
import { setVerbose } from "../../utility/globals.js";
import makeRequest from "../../utility/makeReq.js";

vi.mock("../../utility/makeReq.js", () => ({
    default: vi.fn(),
}));

vi.mock("prettier", () => ({
    default: {
        format: vi.fn(),
    },
}));

const mockedMakeRequest = vi.mocked(makeRequest);
const mockedFormat = vi.mocked(prettier.format);

let outputDir: string;

beforeEach(() => {
    outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "js-recon-download-files-"));
    setScope(["*"]);
    setMaxReqQueue(1);
    mockedMakeRequest.mockReset();
    mockedFormat.mockReset();
});

afterEach(() => {
    setScope([]);
    fs.rmSync(outputDir, { recursive: true, force: true });
    vi.restoreAllMocks();
});

describe("legacy downloadFiles", () => {
    it("does not count a failed filesystem write as a download", async () => {
        mockedMakeRequest.mockResolvedValue(new Response("const ok = true;", { status: 200 }));
        mockedFormat.mockResolvedValue("const ok = true;\n");
        vi.spyOn(fs, "writeFileSync").mockImplementation(() => {
            throw new Error("disk full");
        });
        setVerbose(true);
        const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

        await downloadFiles(["https://example.test/write.js"], outputDir);

        expect(logSpy.mock.calls.flat().join("\n")).not.toContain("Downloaded 1 JS chunks");
        expect(errorSpy.mock.calls.flat().join("\n")).toContain("Failed to write file");
        setVerbose(false);
    });

    it("rejects HTTP and HTML fallback responses before formatting", async () => {
        mockedMakeRequest.mockImplementation(async (url) =>
            url.endsWith("status.js")
                ? new Response("missing", { status: 404, headers: { "content-type": "text/plain" } })
                : new Response("<!doctype html><html></html>", {
                      status: 200,
                      headers: { "content-type": "text/plain" },
                  })
        );
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
        vi.spyOn(console, "log").mockImplementation(() => undefined);

        await downloadFiles(["https://example.test/status.js", "https://example.test/fallback.js"], outputDir);

        expect(mockedFormat).not.toHaveBeenCalled();
        expect(errorSpy).toHaveBeenCalledTimes(2);
        expect(errorSpy.mock.calls.flat().join("\n")).toContain("Invalid response");
    });

    it("lets makeRequest emit the only routine fetch failure diagnostic", async () => {
        mockedMakeRequest.mockResolvedValue(null);
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
        vi.spyOn(console, "log").mockImplementation(() => undefined);

        await downloadFiles(["https://example.test/missing.js"], outputDir);

        expect(mockedMakeRequest).toHaveBeenCalledWith("https://example.test/missing.js", {
            reportErrors: true,
        });
        expect(errorSpy).not.toHaveBeenCalled();
    });

    it("nests the host even when the output root's basename already matches it", async () => {
        mockedMakeRequest.mockResolvedValue(new Response("const ok = true;", { status: 200 }));
        mockedFormat.mockResolvedValue("const ok = true;\n");
        vi.spyOn(console, "log").mockImplementation(() => undefined);
        const hostOutputDir = path.join(outputDir, "example.test");

        await downloadFiles(["https://example.test/assets/chunk.js"], hostOutputDir);

        expect(fs.existsSync(path.join(hostOutputDir, "assets", "chunk.js"))).toBe(false);
        expect(fs.existsSync(path.join(hostOutputDir, "example.test", "assets", "chunk.js"))).toBe(true);
    });

    it("uses the Vue parser for SFC URLs with a query string", async () => {
        mockedMakeRequest.mockResolvedValue(
            new Response("<template><div>ok</div></template>", {
                status: 200,
                headers: { "content-type": "text/html" },
            })
        );
        mockedFormat.mockResolvedValue("<template><div>ok</div></template>\n");
        vi.spyOn(console, "log").mockImplementation(() => undefined);

        await downloadFiles(["https://example.test/components/Card.vue?v=123"], outputDir);

        expect(mockedFormat).toHaveBeenCalledWith(expect.any(String), { parser: "vue" });
        expect(
            fs.existsSync(
                path.join(
                    outputDir,
                    "example.test",
                    "components",
                    getSanitizedAssetFilename("https://example.test/components/Card.vue?v=123")!
                )
            )
        ).toBe(true);
    });
});
