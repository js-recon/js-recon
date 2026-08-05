import { describe, it, expect } from "vitest";
import fc from "fast-check";
import parser from "@babel/parser";
import { extractStrings } from "../../strings/index.js";

/**
 * js-recon's entire pipeline starts by parsing raw JS text pulled from a third-party target's
 * bundle — that text is fully attacker/target-controlled. This fuzz test drives arbitrary and
 * adversarially-shaped strings through the same parse config used across the codebase
 * (`errorRecovery: true`, matching e.g. `map/next_js/utils.ts`) followed by `extractStrings`.
 *
 * `errorRecovery: true` does NOT guarantee `parser.parse` never throws — some errors (e.g. an
 * unterminated string/template literal) are fatal and unrecoverable in Babel regardless of this
 * option. Every real call site in this codebase already wraps `parser.parse` in try/catch for
 * exactly this reason, so a thrown SyntaxError here is expected, catchable behavior, not a bug.
 * What this test actually guards against: (1) `extractStrings` itself throwing or hanging on any
 * AST that *does* parse successfully, however adversarial, and (2) the parse+extract pair hanging
 * (bounded per-property runtime) on pathological input rather than failing fast.
 */

const PARSE_OPTS: parser.ParserOptions = {
    sourceType: "unambiguous",
    plugins: ["jsx", "typescript"],
    errorRecovery: true,
};

/** Parses like every real call site does — catches the expected fatal-syntax-error case. */
const tryParseAndExtract = (code: string): string[] | null => {
    let ast;
    try {
        ast = parser.parse(code, PARSE_OPTS);
    } catch {
        return null; // expected for unrecoverable syntax — real call sites handle this the same way
    }
    return extractStrings(ast);
};

describe("extractStrings fuzz (parse boundary)", () => {
    it("never hangs or throws uncaught on arbitrary unicode input", () => {
        fc.assert(
            fc.property(fc.string({ maxLength: 500 }), (code) => {
                expect(() => tryParseAndExtract(code)).not.toThrow();
            }),
            { numRuns: 300 }
        );
    });

    it("never hangs or throws uncaught on JS-flavored malformed fragments", () => {
        const jsToken = fc.constantFrom(
            "const",
            "function",
            "=>",
            "`",
            '"',
            "'",
            "${",
            "}",
            "(",
            ")",
            "[",
            "]",
            "\\",
            ";",
            "/",
            "*",
            "//",
            "/*",
            "class",
            "..."
        );
        fc.assert(
            fc.property(fc.array(jsToken, { maxLength: 80 }), (tokens) => {
                expect(() => tryParseAndExtract(tokens.join(" "))).not.toThrow();
            }),
            { numRuns: 300 }
        );
    });

    it("never hangs or throws uncaught on pathologically repeated quote/backslash sequences", () => {
        fc.assert(
            fc.property(
                fc.constantFrom('"', "'", "\\", "`", "${"),
                fc.integer({ min: 1, max: 2000 }),
                (unit, count) => {
                    expect(() => tryParseAndExtract(unit.repeat(count))).not.toThrow();
                }
            ),
            { numRuns: 100 }
        );
    });

    it("extractStrings never throws on a successfully-parsed adversarial AST", () => {
        // Valid-but-adversarial JS: deep nesting, many strings, mixed literal kinds.
        const validSnippets = fc.constantFrom(
            "const a = " + "[".repeat(200) + "1" + "]".repeat(200) + ";",
            `const o = {${Array.from({ length: 200 }, (_, i) => `k${i}:"v${i}"`).join(",")}};`,
            "const t = `" + "${1}".repeat(200) + "`;",
            'fetch("' + "/a".repeat(500) + '");'
        );
        fc.assert(
            fc.property(validSnippets, (code) => {
                const ast = parser.parse(code, PARSE_OPTS);
                expect(() => extractStrings(ast)).not.toThrow();
            }),
            { numRuns: 20 }
        );
    });
});
