import { describe, it, expect } from "vitest";
import { detectByMarker } from "../../run/bundler-detect.js";
import { Chunks } from "../../utility/interfaces.js";

function makeChunks(codes: string[]): Chunks {
    const chunks: Chunks = {};
    codes.forEach((code, i) => {
        chunks[`chunk_${i}`] = {
            id: `${i}`,
            description: "",
            loadedOn: [],
            containsFetch: false,
            isAxiosLibrary: false,
            exports: [],
            callStack: [],
            code,
            imports: [],
            file: "",
        };
    });
    return chunks;
}

describe("detectByMarker", () => {
    it("detects react-webpack via __webpack_require__", () => {
        const chunks = makeChunks(["var e = { 0: function(t, n, r) { __webpack_require__(1); } };"]);
        expect(detectByMarker(chunks, ["react-webpack", "react-vite"])).toBe("react-webpack");
    });

    it("detects react-vite via the modulepreload polyfill check", () => {
        const chunks = makeChunks([
            'const t = document.createElement("link").relList; if (t && t.supports && t.supports("modulepreload")) return;',
        ]);
        expect(detectByMarker(chunks, ["react-webpack", "react-vite"])).toBe("react-vite");
    });

    it("returns null when no candidate's markers are present", () => {
        const chunks = makeChunks(["function App() { return React.createElement('div'); }"]);
        expect(detectByMarker(chunks, ["react-webpack", "react-vite"])).toBeNull();
    });

    it("returns null when markers for more than one candidate are present", () => {
        const chunks = makeChunks(["__webpack_require__(1);", '.supports("modulepreload")']);
        expect(detectByMarker(chunks, ["react-webpack", "react-vite"])).toBeNull();
    });

    it("ignores candidates not in the provided list", () => {
        const chunks = makeChunks(["__webpack_require__(1);"]);
        expect(detectByMarker(chunks, ["react-webpack"])).toBe("react-webpack");
    });
});
