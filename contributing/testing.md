# Writing tests for js-recon

New functionality must ship with tests. Which kind depends on what you're adding — see below.

## Unit tests (Vitest)

Test framework is [Vitest](https://vitest.dev/) — ESM-native, TypeScript-native, no build step.

```bash
npm test          # run all unit tests once
npm run test:watch  # watch mode
npm run test:coverage  # run with coverage report
```

**What to test.** Pure functions: anything that takes plain inputs and returns a value without I/O.
Puppeteer, network calls (`makeRequest`), and file writes are intentionally left untested at the
unit level — they're validated end-to-end via the `run` subcommand instead (see below). When a
function mixes I/O with logic, extract the parse/transform step into an exported pure function and
test that:

```typescript
// Exported pure function — testable
export const parseThings = (content: string, baseUrl: string): string[] => {
    /* ... */
};

// Orchestrator — not unit-tested
const myModule = async (url: string): Promise<string[]> => {
    const resp = await makeRequest(url);
    const content = await resp.text();
    return parseThings(content, url);
};
```

**File layout.** Tests live in `src/__tests__/<component>/<name>.test.ts`, mirroring the source
path. Use `describe`/`it` blocks grouped by function name; cover the happy path, edge cases (empty
input, malformed input), and threshold boundaries.

**Local imports use the `.js` extension** (this is an ESM project with `"module": "node16"`):

```typescript
import { fn } from "../../lazyLoad/next_js/myModule.js";
```

**Constructing Babel AST nodes for tests.** If a function under test requires a real Babel AST node
(with `scope`, `path`, correct `start`/`end` offsets), parse a snippet and capture the node via a
`traverse` visitor rather than building it by hand:

```typescript
import parser from "@babel/parser";
import _traverse from "@babel/traverse";
const traverse = (_traverse.default ?? _traverse) as typeof _traverse.default;

function parseExpr(code: string) {
    const src = `const _x = ${code};`;
    const ast = parser.parse(src, { sourceType: "unambiguous", plugins: ["jsx", "typescript"] });
    let node: any;
    traverse(ast, {
        VariableDeclarator(p) {
            node = p.node.init;
            p.stop();
        },
    });
    return { node, src };
}
```

**Avoid GitHub's secret scanner false-positives.** Strings that look like real secrets (webhook
URLs, API keys) get blocked by push protection even inside test files. Assemble them at runtime:

```typescript
// BAD — blocked by secret scanner
const url = "https://hooks.slack.com/services/TABCDEF/BABCDEF/xxxxxxxxxxxx";

// GOOD — assembled at runtime
const parts = ["https://hooks.slack.com/services/T", "ABCDEF/B", "ABCDEF/xxxx"];
const url = parts.join("");
```

## Fuzz tests (fast-check)

js-recon's job is parsing and analyzing JS bundles pulled from third-party targets — that input is
fully untrusted. Functions on that boundary (parsing raw bundle text, resolving URLs/strings out of
it) should get a property-based fuzz test in addition to example-based unit tests, using
[fast-check](https://fast-check.dev/).

```bash
npm run test:fuzz   # runs src/**/*.fuzz.test.ts via vitest.fuzz.config.ts
```

Fuzz tests live alongside the function's regular unit test, named `<name>.fuzz.test.ts`, and are
excluded from the default `npm test` run (they're slower — property-based, hundreds of generated
cases per run). See `src/__tests__/strings/extractStrings.fuzz.test.ts` for the reference shape:
generate arbitrary/adversarial strings, feed them through the same parse config the real call site
uses, and assert the function under test never throws uncaught or hangs. If a parse step can
legitimately throw on malformed input (Babel's `errorRecovery: true` does not guarantee it won't),
wrap it in try/catch inside the test exactly as the real call site does — a caught, expected error
is not a fuzz failure; an uncaught throw or a hang is.

## Smoke tests (CI)

The `rules-smoke-test` GitHub Actions workflow runs js-recon end-to-end against a seeded lab app and
asserts every expected rule fires. If you're adding a new AST/request rule to `js-recon-rules`, seed
the corresponding vulnerability in `js-recon-labs`'s `next_js/vuln-all-rules` app and add the rule ID
to `EXPECTED_RULES` in `scripts/smoke-test.js`. See the root `CLAUDE.md`'s "Rules smoke test (CI)"
section for details.
