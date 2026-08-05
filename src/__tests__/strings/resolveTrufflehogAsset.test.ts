import { describe, it, expect } from "vitest";
import { resolveAssetName } from "../../strings/trufflehogDownload.js";

describe("resolveAssetName", () => {
    it("maps darwin/x64 to darwin_amd64", () => {
        expect(resolveAssetName("darwin", "x64")).toBe("darwin_amd64");
    });

    it("maps darwin/arm64 to darwin_arm64", () => {
        expect(resolveAssetName("darwin", "arm64")).toBe("darwin_arm64");
    });

    it("maps linux/x64 to linux_amd64", () => {
        expect(resolveAssetName("linux", "x64")).toBe("linux_amd64");
    });

    it("maps linux/arm64 to linux_arm64", () => {
        expect(resolveAssetName("linux", "arm64")).toBe("linux_arm64");
    });

    it("maps win32/x64 to windows_amd64", () => {
        expect(resolveAssetName("win32", "x64")).toBe("windows_amd64");
    });

    it("maps win32/arm64 to windows_arm64", () => {
        expect(resolveAssetName("win32", "arm64")).toBe("windows_arm64");
    });

    it("throws for an unsupported platform", () => {
        expect(() => resolveAssetName("freebsd" as NodeJS.Platform, "x64")).toThrow(/Unsupported platform\/arch/);
    });

    it("throws for an unsupported arch", () => {
        expect(() => resolveAssetName("linux", "ia32")).toThrow(/Unsupported platform\/arch/);
    });
});
