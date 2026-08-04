// Refactor module for Vite-bundled React apps.
//
// Vite (with rolldown) produces already-split ESM files. Each chunk:
//   - imports rolldown interop helpers from rolldown-runtime-*.js
//   - imports from a vendor chunk (vendor-react-*.js)
//   - uses CJS-interop wrappers: var X = __toESM(getter(), 1)
//   - calls library APIs via (0, X.prop)(args)
//
// This module:
//   1. Analyzes the vendor chunk to classify exports
//   2. For each app chunk, rewrites (0, X.prop)(args) → prop(args)
//   3. Applies Passes E/F/G via applyModuleCleanupPasses
//   4. Rewrites direct vendor imports using vendor export map
//   5. Cleans up rolldown boilerplate

import { parse } from "@babel/parser";
import _traverse from "@babel/traverse";
import * as t from "@babel/types";
import _generator from "@babel/generator";
import prettier from "prettier";
import path from "path";

const traverse = (_traverse.default ?? _traverse) as typeof _traverse.default;

import { cs_mast_init, ScatCategory } from "@shriyanss/cs-mast";
import { Chunks } from "../../utility/interfaces.js";
import { applyModuleCleanupPasses } from "../react/transform.js";
import {
    REACT_CANONICAL,
    JSX_RUNTIME_CANONICAL,
    REACT_DOM_CLIENT_CANONICAL,
    REACT_ROUTER_DOM_CANONICAL,
    librarySource,
    type LibraryType,
} from "../react/library-classify.js";
import { analyzeVendorChunk, type VendorExportInfo } from "./vendor-analyze.js";
import { printMsg, MSG } from "../../utility/printMsg.js";

const generate = (_generator as unknown as { default: typeof _generator }).default ?? _generator;

// ---------------------------------------------------------------------------
// Vite chunk classification helpers
// ---------------------------------------------------------------------------

/**
 * Identifies the rolldown-runtime chunk. It always has a single import (from itself)
 * and exports __toESM (as 'n') and __commonJS (as 't').
 */
function isRolldownRuntimeChunk(filename: string): boolean {
    return /rolldown[-_]runtime/i.test(path.basename(filename));
}

/**
 * Identifies the vendor chunk. Typically vendor-react-*.js
 */
function isVendorChunk(filename: string): boolean {
    return /vendor[-_]react/i.test(path.basename(filename));
}

// ---------------------------------------------------------------------------
// Library classification
// ---------------------------------------------------------------------------

type LibraryUsageInfo = {
    varName: string;
    libType: LibraryType;
    exportMap: Map<string, string>;
};

/**
 * Builds a map of chunk-local var name → VendorExportInfo by scanning import
 * declarations against all known vendor chunk export maps.
 */
function buildLocalVarToVendorExport(
    statements: t.Statement[],
    vendorExportMaps: Map<string, Map<string, VendorExportInfo>>
): Map<string, VendorExportInfo> {
    const result = new Map<string, VendorExportInfo>();
    for (const stmt of statements) {
        if (!t.isImportDeclaration(stmt)) continue;
        const sourceBase = path.basename(stmt.source.value);
        for (const [vendorBasename, exportMap] of vendorExportMaps) {
            if (!sourceBase.includes(vendorBasename.replace(/\.js$/, ""))) continue;
            for (const spec of stmt.specifiers) {
                if (!t.isImportSpecifier(spec)) continue;
                const importedName = t.isIdentifier(spec.imported)
                    ? spec.imported.name
                    : (spec.imported as t.StringLiteral).value;
                const localName = spec.local.name;
                const exportInfo = exportMap.get(importedName);
                if (exportInfo) result.set(localName, exportInfo);
            }
            break;
        }
    }
    return result;
}

/**
 * Finds interop vars and classifies them using vendor export map info.
 *
 * Handles two rolldown patterns:
 *   - `var X = toESM(getter(), 1)`  — wrapped CJS interop
 *   - `var X = getter()`            — direct CJS call (no toESM)
 *
 * Returns interopVarNames (set of vars to remove) and varToLib (for Pass D).
 */
function detectInteropVars(
    statements: t.Statement[],
    toEsmLocalName: string | null,
    localVarToVendorExport: Map<string, VendorExportInfo>
): { interopVarNames: Set<string>; varToLib: Map<string, LibraryUsageInfo> } {
    const interopVarNames = new Set<string>();
    const varToLib = new Map<string, LibraryUsageInfo>();

    for (const stmt of statements) {
        if (!t.isVariableDeclaration(stmt)) continue;
        for (const decl of stmt.declarations) {
            if (!t.isIdentifier(decl.id) || !decl.init) continue;
            if (!t.isCallExpression(decl.init)) continue;
            const callee = decl.init.callee;
            const args = decl.init.arguments;
            const varName = (decl.id as t.Identifier).name;

            let getterExportInfo: VendorExportInfo | undefined;

            // Pattern 1: toESM(getter(), 1)
            if (
                toEsmLocalName &&
                t.isIdentifier(callee, { name: toEsmLocalName }) &&
                args.length >= 1 &&
                t.isCallExpression(args[0]) &&
                t.isIdentifier((args[0] as t.CallExpression).callee)
            ) {
                const getterName = ((args[0] as t.CallExpression).callee as t.Identifier).name;
                const info = localVarToVendorExport.get(getterName);
                if (info?.isCjsGetter) getterExportInfo = info;
            }

            // Pattern 2: getter() — direct CJS call without toESM wrapper
            if (!getterExportInfo && t.isIdentifier(callee)) {
                const info = localVarToVendorExport.get(callee.name);
                if (info?.isCjsGetter) getterExportInfo = info;
            }

            if (!getterExportInfo) continue;
            interopVarNames.add(varName);

            let libType: LibraryType = "unknown";
            if (getterExportInfo.library === "react") libType = "react";
            else if (getterExportInfo.library === "react/jsx-runtime") libType = "react-jsx-runtime";
            else if (getterExportInfo.library === "react-dom/client") libType = "react-dom-client";

            if (libType !== "unknown") {
                varToLib.set(varName, { varName, libType, exportMap: new Map() });
            }
        }
    }

    return { interopVarNames, varToLib };
}

// ---------------------------------------------------------------------------
// Vite Pass D — rewrite (0, X.prop)(args) → prop(args)
// ---------------------------------------------------------------------------

/**
 * Rewrites `(0, X.prop)(args)` → `prop(args)` for known library vars.
 * Also rewrites bare `X.prop` member accesses in non-call positions.
 * Returns a Map from library source path → set of used canonical names.
 */
function rewriteViteLibraryCalls(
    statements: t.Statement[],
    varToLib: Map<string, LibraryUsageInfo>
): Map<string, Set<string>> {
    const usedExports = new Map<string, Set<string>>();

    const record = (libType: LibraryType, name: string) => {
        const src = librarySource(libType);
        if (!src) return;
        if (!usedExports.has(src)) usedExports.set(src, new Set());
        usedExports.get(src)!.add(name);
    };

    const resolveViteProp = (varName: string, prop: string): { canonical: string; libType: LibraryType } | null => {
        const info = varToLib.get(varName);
        if (!info || info.libType === "unknown") return null;

        const isCanonical = (name: string): boolean => {
            if (info.libType === "react") return REACT_CANONICAL.has(name);
            if (info.libType === "react-jsx-runtime") return JSX_RUNTIME_CANONICAL.has(name) || name === "Fragment";
            if (info.libType === "react-dom-client") return REACT_DOM_CLIENT_CANONICAL.has(name);
            if (info.libType === "react-router-dom") return REACT_ROUTER_DOM_CANONICAL.has(name);
            return false;
        };

        if (isCanonical(prop)) return { canonical: prop, libType: info.libType };
        return null;
    };

    const syntheticFile = t.file(t.program(statements, [], "module"));
    traverse(syntheticFile, {
        CallExpression(p) {
            const callee = p.node.callee as t.Expression;
            // (0, X.prop) form
            if (t.isSequenceExpression(callee) && callee.expressions.length === 2) {
                const [first, second] = callee.expressions;
                if (
                    t.isNumericLiteral(first) &&
                    first.value === 0 &&
                    t.isMemberExpression(second) &&
                    !second.computed &&
                    t.isIdentifier(second.object) &&
                    t.isIdentifier(second.property)
                ) {
                    const varName = (second.object as t.Identifier).name;
                    const prop = (second.property as t.Identifier).name;
                    const resolved = resolveViteProp(varName, prop);
                    if (resolved) {
                        record(resolved.libType, resolved.canonical);
                        p.node.callee = t.identifier(resolved.canonical);
                    }
                }
                return;
            }
            // X.prop form
            if (
                t.isMemberExpression(callee) &&
                !callee.computed &&
                t.isIdentifier(callee.object) &&
                t.isIdentifier(callee.property)
            ) {
                const varName = (callee.object as t.Identifier).name;
                const prop = (callee.property as t.Identifier).name;
                const resolved = resolveViteProp(varName, prop);
                if (resolved) {
                    record(resolved.libType, resolved.canonical);
                    p.node.callee = t.identifier(resolved.canonical);
                }
            }
        },
        MemberExpression(p) {
            // Non-call positions
            if (t.isCallExpression(p.parent) && p.parent.callee === p.node) return;
            if (p.node.computed) return;
            if (!t.isIdentifier(p.node.object) || !t.isIdentifier(p.node.property)) return;
            const varName = (p.node.object as t.Identifier).name;
            const prop = (p.node.property as t.Identifier).name;
            const resolved = resolveViteProp(varName, prop);
            if (resolved) {
                record(resolved.libType, resolved.canonical);
                p.replaceWith(t.identifier(resolved.canonical));
                p.skip();
            }
        },
    });

    return usedExports;
}

// ---------------------------------------------------------------------------
// Boilerplate removal
// ---------------------------------------------------------------------------

/**
 * Removes the `__vite__mapDeps` const declaration.
 * Pattern: const __vite__mapDeps = (i, m=__vite__mapDeps, d=(m.f||(m.f=[...]))) => ...
 */
function removeViteMapDeps(statements: t.Statement[]): t.Statement[] {
    return statements.filter((stmt) => {
        if (!t.isVariableDeclaration(stmt)) return true;
        return !stmt.declarations.some(
            (d) => t.isIdentifier(d.id) && (d.id as t.Identifier).name === "__vite__mapDeps"
        );
    });
}

/**
 * Removes modulepreload setup IIFEs.
 * Pattern: (function(){let e=document.createElement(`link`).relList;...})()
 */
function removeModulepreloadIIFE(statements: t.Statement[]): t.Statement[] {
    return statements.filter((stmt) => {
        if (!t.isExpressionStatement(stmt)) return true;
        const expr = stmt.expression;
        if (!t.isCallExpression(expr)) return true;
        const callee = expr.callee;
        if (!t.isFunctionExpression(callee) && !t.isArrowFunctionExpression(callee)) return true;
        // Detect modulepreload setup by looking for `relList` or `modulepreload` in body
        try {
            const bodyCode = generate(callee).code;
            if (
                bodyCode.includes("relList") ||
                bodyCode.includes("modulepreload") ||
                (bodyCode.includes("createElement") && bodyCode.includes("link"))
            ) {
                return false;
            }
        } catch {
            // skip
        }
        return true;
    });
}

/**
 * Simplifies dynamic imports wrapped with __vite__mapDeps preloading helper.
 * Pattern: (0, o.lazy)(() => o(()=>import('./X.js'), __vite__mapDeps([0,1,2])))
 * After Pass D, becomes: lazy(() => o(()=>import('./X.js'), __vite__mapDeps([0,1,2])))
 * We simplify the inner call: lazy(() => import('./X.js'))
 */
function simplifyViteMapDepsImports(statements: t.Statement[]): void {
    const syntheticFile = t.file(t.program(statements, [], "module"));
    traverse(syntheticFile, {
        CallExpression(p) {
            // Look for: lazy(() => someWrapper(()=>import('./X.js'), __vite__mapDeps(...)))
            const callee = p.node.callee;
            if (!t.isIdentifier(callee, { name: "lazy" })) return;
            if (p.node.arguments.length !== 1) return;
            const arg = p.node.arguments[0];
            if (!t.isArrowFunctionExpression(arg)) return;
            const body = arg.body;
            if (!t.isCallExpression(body)) return;
            // The inner call has 2 args: ()=>import('./X.js'), __vite__mapDeps(...)
            const innerArgs = body.arguments;
            if (innerArgs.length < 2) return;
            const firstInnerArg = innerArgs[0];
            if (!t.isArrowFunctionExpression(firstInnerArg)) return;
            const innerBody = firstInnerArg.body;
            if (!t.isCallExpression(innerBody)) return;
            if (!t.isImport(innerBody.callee)) return;
            // We found: lazy(() => wrapper(() => import('./X.js'), __vite__mapDeps(...)))
            // Simplify to: lazy(() => import('./X.js'))
            p.node.arguments = [t.arrowFunctionExpression([], innerBody)];
        },
    });
}

// ---------------------------------------------------------------------------
// Import rewriting for direct vendor imports
// ---------------------------------------------------------------------------

/**
 * Rewrites vendor imports using all known vendor export maps.
 * Removes all vendor chunk imports and replaces direct (non-CJS-getter) exports
 * with proper library imports. Returns new statement list and rename map.
 */
function rewriteVendorImports(
    statements: t.Statement[],
    vendorExportMaps: Map<string, Map<string, VendorExportInfo>>
): { newStatements: t.Statement[]; renames: Map<string, string> } {
    const renames = new Map<string, string>(); // localSpecifier → canonicalName
    const newLibImports = new Map<string, Set<string>>(); // libraryPath → set of canonical names
    const vendorSources = new Set<string>(); // exact source values to remove

    for (const stmt of statements) {
        if (!t.isImportDeclaration(stmt)) continue;
        const source = stmt.source.value;
        const sourceBase = path.basename(source);

        let exportMap: Map<string, VendorExportInfo> | undefined;
        for (const [vendorBasename, map] of vendorExportMaps) {
            if (sourceBase.includes(vendorBasename.replace(/\.js$/, ""))) {
                exportMap = map;
                vendorSources.add(source);
                break;
            }
        }
        if (!exportMap) continue;

        for (const spec of stmt.specifiers) {
            if (!t.isImportSpecifier(spec)) continue;
            const importedName = t.isIdentifier(spec.imported)
                ? spec.imported.name
                : (spec.imported as t.StringLiteral).value;
            const localName = spec.local.name;

            const exportInfo = exportMap.get(importedName);
            if (!exportInfo || exportInfo.isCjsGetter) continue;

            // Direct export (react-router-dom component or similar)
            const libPath = exportInfo.library;
            if (!newLibImports.has(libPath)) newLibImports.set(libPath, new Set());
            newLibImports.get(libPath)!.add(exportInfo.canonicalName);

            if (localName !== exportInfo.canonicalName) {
                renames.set(localName, exportInfo.canonicalName);
            }
        }
    }

    // Remove all vendor import statements (identified by exact source value)
    const filtered = statements.filter((stmt) => {
        if (!t.isImportDeclaration(stmt)) return true;
        return !vendorSources.has(stmt.source.value);
    });

    // Build new import declarations for direct exports
    const libImportStmts: t.Statement[] = [];
    for (const [libPath, canonicalNames] of newLibImports) {
        if (canonicalNames.size === 0) continue;
        const specifiers = Array.from(canonicalNames).map((name) =>
            t.importSpecifier(t.identifier(name), t.identifier(name))
        );
        libImportStmts.push(t.importDeclaration(specifiers, t.stringLiteral(libPath)));
    }

    return {
        newStatements: [...libImportStmts, ...filtered],
        renames,
    };
}

/**
 * Renames usages of old identifier names to new names throughout statements.
 */
function applyRenames(statements: t.Statement[], renames: Map<string, string>): void {
    if (renames.size === 0) return;
    const syntheticFile = t.file(t.program(statements, [], "module"));
    traverse(syntheticFile, {
        Identifier(p) {
            const newName = renames.get(p.node.name);
            if (!newName) return;
            // Skip binding declarations and import specifiers
            if (p.parentPath?.isImportSpecifier()) return;
            if (p.parentPath?.isImportDefaultSpecifier()) return;
            p.node.name = newName;
        },
        JSXIdentifier(p) {
            const newName = renames.get(p.node.name);
            if (!newName) return;
            p.node.name = newName;
        },
    });
}

// ---------------------------------------------------------------------------
// Build new library import declarations from usedExports
// ---------------------------------------------------------------------------

function buildLibImportStatements(usedExports: Map<string, Set<string>>): t.ImportDeclaration[] {
    const decls: t.ImportDeclaration[] = [];
    for (const [libPath, names] of usedExports) {
        if (names.size === 0) continue;
        const specifiers = Array.from(names).map((name) => t.importSpecifier(t.identifier(name), t.identifier(name)));
        decls.push(t.importDeclaration(specifiers, t.stringLiteral(libPath)));
    }
    return decls;
}

// ---------------------------------------------------------------------------
// Prune unused named imports (Pass H equivalent)
// ---------------------------------------------------------------------------

function collectReferencedNames(stmts: t.Statement[]): Set<string> {
    const names = new Set<string>();
    const syntheticFile = t.file(t.program(stmts, [], "module"));
    traverse(syntheticFile, {
        Identifier(p) {
            if (p.parentPath?.isImportSpecifier()) return;
            if (p.parentPath?.isImportDefaultSpecifier()) return;
            if (p.parentPath?.isImportNamespaceSpecifier()) return;
            if (
                p.parentPath?.isMemberExpression() &&
                !(p.parent as t.MemberExpression).computed &&
                p.parentPath.get("property") === p
            )
                return;
            if (
                p.parentPath?.isObjectProperty() &&
                !(p.parent as t.ObjectProperty).computed &&
                p.parentPath.get("key") === p
            )
                return;
            if (p.parentPath?.isJSXAttribute()) return;
            if (p.parentPath?.isJSXOpeningElement() || p.parentPath?.isJSXClosingElement()) return;
            names.add(p.node.name);
        },
        JSXIdentifier(p) {
            names.add(p.node.name);
        },
    });
    return names;
}

function pruneUnusedNamedImports(importStmts: t.Statement[], bodyStmts: t.Statement[]): t.Statement[] {
    const refs = collectReferencedNames(bodyStmts);
    return importStmts
        .map((stmt) => {
            if (!t.isImportDeclaration(stmt)) return stmt;
            const prunedSpecifiers = stmt.specifiers.filter((spec) => {
                if (t.isImportNamespaceSpecifier(spec)) return true;
                if (t.isImportDefaultSpecifier(spec)) return true;
                if (t.isImportSpecifier(spec)) {
                    const localName = t.isIdentifier(spec.local) ? spec.local.name : null;
                    return localName ? refs.has(localName) : true;
                }
                return true;
            });
            if (prunedSpecifiers.length === 0) return null;
            if (prunedSpecifiers.length === stmt.specifiers.length) return stmt;
            return t.importDeclaration(prunedSpecifiers, stmt.source);
        })
        .filter(Boolean) as t.Statement[];
}

// ---------------------------------------------------------------------------
// CS-MAST library detection (file-level)
// ---------------------------------------------------------------------------

const LIB_SIG_SCAT: ScatCategory[] = ["lit", "decl", "loop", "cond"];
const LIB_FILE_CLASSIFICATION_THRESHOLD = 0.51;

const fileIsLibrary = (code: string, libSigs: Set<string>, scatOverride?: ScatCategory[]): boolean => {
    if (libSigs.size === 0) return false;
    try {
        const tree = cs_mast_init(code, {
            hash: "sha256",
            scat: scatOverride ?? LIB_SIG_SCAT,
            sinc: [],
            lang: "js",
            prsr: "@babel/parser",
        });
        const sigs = [...tree._signatureMap.keys()];
        if (sigs.length === 0) return false;
        const matchCount = sigs.filter((s) => libSigs.has(s)).length;
        return matchCount / sigs.length >= LIB_FILE_CLASSIFICATION_THRESHOLD;
    } catch {
        return false;
    }
};

// ---------------------------------------------------------------------------
// Main refactor function
// ---------------------------------------------------------------------------

/**
 * Refactors Vite-bundled React app chunks.
 *
 * @param chunks - Mapped chunks from the Vite app (vendor + app chunks)
 * @param libSigs - Optional set of library signatures for CS-MAST-based chunk filtering
 * @param scatOverride - Optional scat category override (defaults to lit-decl-loop-cond)
 * @returns Record<filename, refactoredCode>
 */
export default async function refactorVite(
    chunks: Chunks,
    libSigs?: Set<string>,
    scatOverride?: ScatCategory[]
): Promise<Record<string, string>> {
    const result: Record<string, string> = {};

    // Step 1: Collect all vendor chunks and detect the rolldown runtime chunk
    const vendorChunks = new Map<string, string>(); // basename → code

    for (const [, chunk] of Object.entries(chunks)) {
        const filename = chunk.file ?? chunk.id ?? "";
        const basename = path.basename(filename);

        if (isVendorChunk(basename)) {
            vendorChunks.set(basename, chunk.code ?? "");
        }
    }

    // Step 2: Analyze all vendor chunks
    const vendorExportMaps = new Map<string, Map<string, VendorExportInfo>>();
    for (const [basename, code] of vendorChunks) {
        vendorExportMaps.set(basename, analyzeVendorChunk(code));
    }

    // Step 3: Process each non-vendor, non-runtime chunk
    for (const [chunkKey, chunk] of Object.entries(chunks)) {
        const filename = chunk.file ?? chunk.id ?? chunkKey;
        const basename = path.basename(filename);

        // Skip vendor and runtime chunks (they're not app code)
        if (isVendorChunk(basename)) continue;
        if (isRolldownRuntimeChunk(basename)) continue;

        const code = chunk.code;
        if (!code || code.trim().length === 0) continue;

        // CS-MAST library detection: skip chunks whose signature set matches the baseline
        if (libSigs && libSigs.size > 0 && fileIsLibrary(code, libSigs, scatOverride)) {
            printMsg(MSG.Info, `[-] Chunk ${basename} matches library baseline — skipping`);
            continue;
        }

        let ast: t.File;
        try {
            ast = parse(code, {
                sourceType: "module",
                plugins: ["jsx"],
                errorRecovery: true,
            });
        } catch {
            // If parsing fails, keep the original code
            result[chunkKey] = code;
            continue;
        }

        let statements: t.Statement[] = ast.program.body as t.Statement[];

        // Step 3a: Find rolldown-runtime import to identify __toESM local name
        let toEsmLocalName: string | null = null;
        for (const stmt of statements) {
            if (!t.isImportDeclaration(stmt)) continue;
            if (!stmt.source.value.includes("rolldown-runtime")) continue;
            for (const spec of stmt.specifiers) {
                if (!t.isImportSpecifier(spec)) continue;
                const imported = t.isIdentifier(spec.imported)
                    ? spec.imported.name
                    : (spec.imported as t.StringLiteral).value;
                // rolldown exports __toESM as 'n'
                if (imported === "n") {
                    toEsmLocalName = spec.local.name;
                }
            }
        }

        // Step 3b: Build local var → vendor export info from import statements
        const localVarToVendorExport = buildLocalVarToVendorExport(statements, vendorExportMaps);

        // Step 3c: Detect interop vars and classify them using vendor export info
        const { interopVarNames, varToLib } = detectInteropVars(statements, toEsmLocalName, localVarToVendorExport);

        // Step 3d: Vite Pass D — rewrite (0, X.prop)(args) → prop(args)
        const usedExports = rewriteViteLibraryCalls(statements, varToLib);

        // Step 3e: Build new library import declarations from usedExports
        const libImportDecls = buildLibImportStatements(usedExports);

        // Step 3f: Apply cleanup passes E/F/G
        const bodyStatements = statements.filter((s) => !t.isImportDeclaration(s));
        const cleanedBody = applyModuleCleanupPasses(bodyStatements);

        // Step 3g: Apply Pass H (prune unused imports)
        const prunedLibImports = pruneUnusedNamedImports(libImportDecls as t.Statement[], cleanedBody);

        // Step 3h: Simplify __vite__mapDeps lazy imports
        simplifyViteMapDepsImports(cleanedBody);

        // Step 3i: Remove Vite boilerplate from body
        const cleanedBodyNoBoilerplate = removeViteMapDeps(removeModulepreloadIIFE(cleanedBody));

        // Step 3j: Rewrite direct vendor imports using all vendor export maps
        const vendorImportStmts = statements.filter((s) => t.isImportDeclaration(s));
        const vendorResult =
            vendorExportMaps.size > 0
                ? rewriteVendorImports(vendorImportStmts, vendorExportMaps)
                : { newStatements: vendorImportStmts, renames: new Map<string, string>() };

        // Remove rolldown-runtime imports from the resulting statement list
        const filteredNonVendorImports = vendorResult.newStatements.filter((s) => {
            if (!t.isImportDeclaration(s)) return true;
            return !s.source.value.includes("rolldown-runtime");
        });
        const vendorRenames = vendorResult.renames;

        // Remove interop var declarators from body.
        // When a declaration mixes interop and non-interop declarators, keep non-interop ones.
        const bodyWithoutInteropVars = cleanedBodyNoBoilerplate
            .map((stmt): t.Statement | null => {
                if (!t.isVariableDeclaration(stmt)) return stmt;
                const keptDeclarators = stmt.declarations.filter(
                    (d) => !(t.isIdentifier(d.id) && interopVarNames.has((d.id as t.Identifier).name))
                );
                if (keptDeclarators.length === 0) return null; // all interop — drop statement
                if (keptDeclarators.length === stmt.declarations.length) return stmt; // unchanged
                return t.variableDeclaration(stmt.kind, keptDeclarators);
            })
            .filter(Boolean) as t.Statement[];

        // Apply vendor renames to the body
        applyRenames(bodyWithoutInteropVars, vendorRenames);

        // Step 3k: Assemble final statement list
        const finalStatements: t.Statement[] = [
            ...filteredNonVendorImports,
            ...prunedLibImports,
            ...bodyWithoutInteropVars,
        ];

        // Step 3l: Generate code
        try {
            const generated = generate(t.file(t.program(finalStatements, [], "module"))).code;
            result[chunkKey] = generated;
        } catch {
            result[chunkKey] = code; // fallback to original
        }
    }

    return result;
}
