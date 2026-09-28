import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TargetCloseError } from "puppeteer";

// Puppeteer stand-in whose page setup is still pending when detection is cancelled. Closing the
// browser orphans a TargetCloseError, as puppeteer-extra-plugin-stealth's un-awaited
// `Network.setUserAgentOverride` does in production.
const harness = vi.hoisted(() => ({ close: null as unknown as ReturnType<typeof vi.fn> }));

vi.mock("../../utility/makeReq.js", () => ({
    default: vi.fn(async () => null),
    getActivePuppeteerProxyArgs: vi.fn(() => ({})),
}));

vi.mock("../../utility/puppeteerInstance.js", () => ({
    default: {
        launch: vi.fn(async () => {
            let rejectSetup!: (err: unknown) => void;
            harness.close = vi.fn(async () => {
                rejectSetup(new TargetCloseError("Protocol error (Network.setUserAgentOverride): Target closed"));
                process.emit("unhandledRejection", new TargetCloseError("Target closed"), Promise.resolve());
            });
            return {
                close: harness.close,
                newPage: vi.fn(() => new Promise((_, reject) => (rejectSetup = reject))),
            };
        }),
    },
}));

import frameworkDetect from "../../lazyLoad/techDetect/index.js";
import { registerFatalHandlers } from "../../utility/fatalHandlers.js";

describe("frameworkDetect cancellation during page setup", () => {
    let exitSpy: ReturnType<typeof vi.spyOn>;
    let teardown: () => void;

    beforeEach(() => {
        exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
        teardown = registerFatalHandlers();
    });

    afterEach(() => {
        teardown();
        exitSpy.mockRestore();
    });

    it("closes the browser once, returns null, and treats the orphaned TargetCloseError as expected", async () => {
        const controller = new AbortController();
        const detection = frameworkDetect("https://example.test", controller.signal);
        setTimeout(() => controller.abort(), 50);

        await expect(detection).resolves.toBeNull();
        expect(harness.close).toHaveBeenCalledTimes(1);
        expect(exitSpy).not.toHaveBeenCalled();
    }, 5_000);
});
