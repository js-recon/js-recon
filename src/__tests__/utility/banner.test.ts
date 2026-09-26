import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "jsr-banner-"));
vi.mock("os", async (orig) => {
    const actual = (await orig()) as typeof import("os");
    return { ...actual, default: { ...actual, homedir: () => home } };
});
vi.mock("@shriyanss/cli-print-img", () => ({
    printImage: vi.fn(() => Promise.reject(new Error("Could not find MIME for Buffer"))),
}));

const { printBanner } = await import("../../utility/banner.js");
const logo = path.join(home, ".js-recon", "logo.png");

describe("printBanner", () => {
    let logSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        fs.mkdirSync(path.dirname(logo), { recursive: true });
        fs.writeFileSync(logo, "not a png");
        logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    });

    afterEach(() => {
        logSpy.mockRestore();
    });

    it("survives a logo render failure, prints the text banner and drops the corrupt cache", async () => {
        await expect(printBanner()).resolves.toBeUndefined();
        expect(logSpy.mock.calls.flat().join("\n")).toContain("JS Recon");
        expect(fs.existsSync(logo)).toBe(false);
    });
});
