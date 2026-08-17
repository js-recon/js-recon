/**
 * Vue Vite refactor (`-t vue-vite`).
 *
 * Vue 3 + Vite produces a main index chunk (containing all of Vue core +
 * vue-router + app utilities) and small lazy-loaded page chunks. The page
 * chunks import a handful of minified Vue runtime functions from the index:
 *
 *   import { _ as t, c as a, a as o, o as s } from "./index-Dcf91m-J.js"
 *
 * This module:
 *   1. Identifies the main index chunk (contains __vccOpts)
 *   2. Analyses it with analyzeVueIndexChunk() to map alias → canonical name
 *   3. For each page chunk, rewrites the index import to canonical Vue imports
 *   4. Applies cleanup passes (G: Babel helpers, H: unused import pruning)
 *   5. Inlines _export_sfc as a local helper when used
 */

import * as parser from "@babel/parser";
import traverse from "@babel/traverse";
import { NodePath } from "@babel/traverse";
import _generate from "@babel/generator";
import * as t from "@babel/types";
import path from "path";

import { Chunks } from "../../utility/interfaces.js";
import { analyzeVueIndexChunk, VueExportMap, VUE_PUBLIC_API } from "./vendor-analyze-vue.js";
import { applyModuleCleanupPasses } from "../react/transform.js";
import { printMsg, MSG } from "../../utility/printMsg.js";

const generate = (_generate as any).default ?? _generate;

// _export_sfc helper — inlined when the page chunk uses it but it is not
// available in the public Vue API. This is the exact function that
// @vitejs/plugin-vue emits in every compiled SFC.
const EXPORT_SFC_HELPER = `
const _export_sfc = (sfc, props) => {
  const target = sfc.__vccOpts || sfc;
  for (const [key, val] of props) target[key] = val;
  return target;
};`.trim();

// ---------------------------------------------------------------------------
// Chunk classification
// ---------------------------------------------------------------------------

function isMainIndexChunk(filename: string, code: string): boolean {
    // The main index chunk is the large one that contains __vccOpts.
    // Page chunks are tiny (<5 kB) and only import from the index.
    return code.includes("__vccOpts") && code.length > 5000;
}

function isPageChunk(filename: string, code: string): boolean {
    // Small chunk that starts with an import from the index file.
    return code.length < 20000 && /^import\s*\{/.test(code.trim()) && code.includes("export");
}

// ---------------------------------------------------------------------------
// Import rewriting
// ---------------------------------------------------------------------------

/**
 * Rewrites `import { _ as t, c as a, ... } from "./index-*.js"` in a page
 * chunk to `import { createElementVNode as a, openBlock as s, ... } from "vue"`.
 *
 * Returns the transformed statements and a flag indicating whether the
 * _export_sfc helper is needed.
 */
function rewriteVueIndexImport(
    statements: t.Statement[],
    vueExportMap: VueExportMap,
    indexFilename: string
): { statements: t.Statement[]; needsExportSfc: boolean; exportSfcAliases: string[] } {
    const indexBase = path.basename(indexFilename).replace(/\.js$/, "");
    let needsExportSfc = false;
    const exportSfcAliases: string[] = []; // local variable names that alias _export_sfc

    const newStatements = statements.map((stmt) => {
        if (!t.isImportDeclaration(stmt)) return stmt;

        const src = stmt.source.value;
        // Match if source looks like ./index-<hash>.js (or similar)
        const srcBase = path.basename(src).replace(/\.js$/, "");
        const isIndexImport = srcBase === indexBase || /^index-/.test(srcBase) || /^index$/.test(srcBase);

        if (!isIndexImport) return stmt;

        // Map each specifier to its canonical Vue name.
        const vueImports: Array<{ canonical: string; local: string }> = [];

        for (const spec of stmt.specifiers) {
            if (!t.isImportSpecifier(spec)) continue;
            const importedName = t.isIdentifier(spec.imported)
                ? spec.imported.name
                : (spec.imported as t.StringLiteral).value;
            const localName = spec.local.name;

            const canonical = vueExportMap.get(importedName);
            if (!canonical) {
                // Unknown export — keep importing from index with original name.
                vueImports.push({ canonical: importedName, local: localName });
                continue;
            }

            if (canonical === "_export_sfc") {
                needsExportSfc = true;
                // Record the local alias so we can emit `const <alias> = _export_sfc;`
                if (localName !== "_export_sfc") exportSfcAliases.push(localName);
            } else if (VUE_PUBLIC_API.has(canonical)) {
                vueImports.push({ canonical, local: localName });
            } else {
                // Not a public API — keep the import but from index.
                vueImports.push({ canonical: importedName, local: localName });
            }
        }

        // Build new import declaration from 'vue' for public API names.
        const vueSpecifiers: t.ImportSpecifier[] = vueImports
            .filter(({ canonical }) => VUE_PUBLIC_API.has(canonical))
            .map(({ canonical, local }) => t.importSpecifier(t.identifier(local), t.identifier(canonical)));

        if (vueSpecifiers.length === 0) {
            // All specifiers were _export_sfc — drop the import statement.
            return null as unknown as t.Statement;
        }

        return t.importDeclaration(vueSpecifiers, t.stringLiteral("vue"));
    });

    return {
        statements: newStatements.filter(Boolean),
        needsExportSfc,
        exportSfcAliases,
    };
}

// ---------------------------------------------------------------------------
// Main refactor entry
// ---------------------------------------------------------------------------

/**
 * Refactors all Vue Vite chunks.
 *
 * Input: `chunks` map from mapped.json (chunk id → Chunk).
 *   - One entry is the large main index chunk (contains all of Vue runtime).
 *   - Remaining entries are small page/component chunks.
 *
 * Output: map of chunk id → refactored ES module code.
 *
 * Page chunks have their index imports rewritten to canonical `vue` imports.
 * The main index chunk is NOT included in the output (it is library/runtime code).
 */
export async function refactorVueVite(chunks: Chunks): Promise<Record<string, string>> {
    const results: Record<string, string> = {};

    // Step 1: Find and analyse the main index chunk.
    let vueExportMap: VueExportMap = new Map();
    let indexChunkId: string | null = null;
    let indexFilename: string = "index";

    for (const [id, chunk] of Object.entries(chunks)) {
        const code = chunk.code.replace(/^\/\/ File Source:[^\n]*\n/, "");
        if (isMainIndexChunk(chunk.file ?? id, code)) {
            indexChunkId = id;
            indexFilename = chunk.file ?? id;
            printMsg(MSG.Header, `[i] Analysing Vue index chunk: ${id}`);
            vueExportMap = analyzeVueIndexChunk(code);
            printMsg(
                MSG.Header,
                `[i] Mapped ${vueExportMap.size} Vue export aliases: ` +
                    Array.from(vueExportMap.entries())
                        .map(([a, c]) => `${a}→${c}`)
                        .join(", ")
            );
            break;
        }
    }

    if (vueExportMap.size === 0) {
        printMsg(MSG.Warn, "[~] No Vue index chunk found — processing all chunks as standalone");
    }

    // Step 2: Process page chunks.
    for (const [id, chunk] of Object.entries(chunks)) {
        if (id === indexChunkId) continue; // skip the main index bundle

        const rawCode = chunk.code.replace(/^\/\/ File Source:[^\n]*\n/, "");
        if (!rawCode.trim()) continue;

        const filename = chunk.file ?? id;
        printMsg(MSG.Header, `[i] Processing Vue (vite) chunk: ${id}`);

        let ast: t.File;
        try {
            ast = parser.parse(rawCode, {
                sourceType: "module",
                plugins: ["jsx"],
                errorRecovery: true,
            });
        } catch {
            printMsg(MSG.Warn, `[!] Failed to parse chunk ${id} — skipping`);
            continue;
        }

        let stmts = ast.program.body;

        // Step 2a: Rewrite the index import to canonical Vue imports.
        const {
            statements: rewritten,
            needsExportSfc,
            exportSfcAliases,
        } = rewriteVueIndexImport(stmts, vueExportMap, indexFilename);
        stmts = rewritten;

        // Step 2b: Insert _export_sfc helper and aliases after all import declarations.
        // Import statements must stay at the top of an ESM module.
        if (needsExportSfc) {
            const helperAst = parser.parse(EXPORT_SFC_HELPER, { sourceType: "module" });
            const aliasDecls = exportSfcAliases.map((alias) =>
                t.variableDeclaration("const", [t.variableDeclarator(t.identifier(alias), t.identifier("_export_sfc"))])
            );
            // Split existing statements: imports first, then body.
            const importStmts = stmts.filter((s) => t.isImportDeclaration(s));
            const bodyStmts = stmts.filter((s) => !t.isImportDeclaration(s));
            stmts = [...importStmts, ...helperAst.program.body, ...aliasDecls, ...bodyStmts];
        }

        // Step 2c: Apply shared cleanup passes (E: slicedToArray, G: Babel helpers).
        // Pass F (JSX recovery) is harmless on Vue render functions and is included.
        const cleanedStmts = applyModuleCleanupPasses(stmts);

        // Step 2d: Generate code.
        const fakeProgram = t.program(cleanedStmts, [], "module");
        const { code: generated } = generate(fakeProgram, {
            compact: false,
            jsescOption: { minimal: true },
        });

        results[id] = generated;
    }

    return results;
}

export default refactorVueVite;
