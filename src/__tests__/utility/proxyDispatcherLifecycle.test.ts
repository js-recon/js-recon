import type { Dispatcher } from "undici";
import { describe, expect, it, vi } from "vitest";
import { withManagedDispatcher } from "../../utility/makeReq.js";

const makeDispatcher = () => {
    const close = vi.fn(async () => undefined);
    const destroy = vi.fn(async () => undefined);
    return {
        dispatcher: { close, destroy } as unknown as Dispatcher,
        close,
        destroy,
    };
};

describe("managed proxy dispatcher lifecycle", () => {
    it("closes a dispatcher after the callback consumes its response", async () => {
        const { dispatcher, close, destroy } = makeDispatcher();

        const result = await withManagedDispatcher(dispatcher, async (options) => {
            expect(options.dispatcher).toBe(dispatcher);
            return "complete";
        });

        expect(result).toBe("complete");
        expect(close).toHaveBeenCalledOnce();
        expect(destroy).not.toHaveBeenCalled();
    });

    it("destroys a dispatcher when the callback fails", async () => {
        const { dispatcher, close, destroy } = makeDispatcher();

        await expect(
            withManagedDispatcher(dispatcher, async () => {
                throw new Error("request failed");
            })
        ).rejects.toThrow("request failed");

        expect(destroy).toHaveBeenCalledOnce();
        expect(close).not.toHaveBeenCalled();
    });

    it("runs without dispatcher options when no dispatcher is needed", async () => {
        await expect(
            withManagedDispatcher(null, async (options) => {
                expect(options).toEqual({});
                return 42;
            })
        ).resolves.toBe(42);
    });
});
