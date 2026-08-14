import { beforeEach, describe, expect, it, vi } from "vitest";

const makeRequest = vi.hoisted(() => vi.fn());

vi.mock("../../utility/makeReq.js", () => ({ default: makeRequest }));

import reactFollowImports from "../../lazyLoad/react/react_followImports.js";

beforeEach(() => {
    makeRequest.mockReset();
});

describe("react_followImports compact output", () => {
    it("aggregates a failing batch without emitting one warning per URL", async () => {
        makeRequest.mockRejectedValue(new Error("network failed"));
        const warnSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const urls = ["https://example.test/one.js", "https://example.test/two.js", "https://example.test/three.js"];

        await expect(reactFollowImports(urls, 2, "https://example.test", new Set(), 3, true)).resolves.toEqual([]);

        expect(warnSpy).toHaveBeenCalledTimes(1);
        const warning = warnSpy.mock.calls.flat().join("\n");
        expect(warning).toContain("3");
        expect(warning).not.toContain("one.js");
    });
});

describe("react_followImports — Vite dev-server import specifiers (js-recon-internal-docs#191)", () => {
    it("follows a .jsx import specifier, not just bare .js/.mjs", async () => {
        makeRequest.mockImplementation(async (url: string) => ({
            status: 200,
            headers: { get: () => null },
            text: async () =>
                url.endsWith("/src/main.jsx") ? `import App from "/src/App.jsx";` : "export default function App() {}",
        }));

        const discovered = await reactFollowImports(
            ["http://localhost:3000/src/main.jsx"],
            20,
            "http://localhost:3000",
            new Set(),
            1,
            true
        );

        expect(discovered).toContain("http://localhost:3000/src/App.jsx");
    });

    it("follows an import specifier with a cache-busting query string", async () => {
        makeRequest.mockImplementation(async () => ({
            status: 200,
            headers: { get: () => null },
            text: async () => `import __r from "/node_modules/.vite/deps/react.js?v=0f5f446c";`,
        }));

        const discovered = await reactFollowImports(
            ["http://localhost:3000/src/main.jsx"],
            20,
            "http://localhost:3000",
            new Set(),
            1,
            true
        );

        expect(discovered).toContain("http://localhost:3000/node_modules/.vite/deps/react.js?v=0f5f446c");
    });
});
