// Analyzes a Vite vendor chunk to build a map of exported names → canonical library API names.
// Used to rewrite minified direct vendor imports (like r = Link from react-router-dom).

import { parse } from "@babel/parser";
import traverse from "@babel/traverse";
import * as t from "@babel/types";
import generate from "@babel/generator";

import {
    REACT_CANONICAL,
    JSX_RUNTIME_CANONICAL,
    REACT_DOM_CLIENT_CANONICAL,
    REACT_ROUTER_DOM_CANONICAL,
} from "../react/library-classify.js";

export type VendorExportInfo = {
    canonicalName: string;
    library: "react" | "react-dom/client" | "react/jsx-runtime" | "react-router-dom";
    /** true if this export is a CJS module getter (needs __toESM interop wrapping) */
    isCjsGetter: boolean;
};

/**
 * Determines which library a CJS module corresponds to by inspecting its factory function.
 * Returns the library identifier or null if unknown.
 *
 * The factory is the first argument to __commonJS(factory).
 * Its first parameter is the exports object (e.g. `e` in `(e) => { e.jsx = ... }`).
 */
function classifyFactory(
    factory: t.ArrowFunctionExpression | t.FunctionExpression
): "react" | "react-dom/client" | "react/jsx-runtime" | null {
    // Derive the exports parameter name (first param, e.g. "e")
    const exportsParam = factory.params[0];
    const exportsParamName =
        exportsParam && t.isIdentifier(exportsParam) ? (exportsParam as t.Identifier).name : "exports";

    let bodyCode: string;
    try {
        bodyCode = generate(factory.body).code;
    } catch {
        return null;
    }

    // react-dom/client: exports createRoot
    if (bodyCode.includes("createRoot")) {
        return "react-dom/client";
    }
    // react/jsx-runtime: exports both jsx and jsxs via the exports parameter
    // Pattern: exportsParam.jsx = ..., exportsParam.jsxs = ...
    if (bodyCode.includes(`${exportsParamName}.jsx =`) && bodyCode.includes(`${exportsParamName}.jsxs =`)) {
        return "react/jsx-runtime";
    }
    // React: uses Symbol.for react.element / react.transitional.element sentinel
    if (
        bodyCode.includes("react.element") ||
        bodyCode.includes("react.transitional.element") ||
        bodyCode.includes("ReactCurrentOwner") ||
        bodyCode.includes("__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED")
    ) {
        return "react";
    }
    return null;
}

/**
 * Analyzes a Vite vendor chunk to build a map of exported names → VendorExportInfo.
 *
 * The vendor chunk (vendor-react-*.js) typically:
 *   1. Imports rolldown interop helpers (__commonJS, __toESM) from the runtime chunk
 *   2. Wraps CJS modules (React, jsx-runtime, react-dom) in __commonJS calls
 *   3. Directly exports react-router-dom APIs with .displayName assignments
 *   4. Has a single export statement: export { localVar as exportedName, ... }
 *
 * Returns a Map from exported name (e.g. "r", "n", "t") to VendorExportInfo.
 */
export function analyzeVendorChunk(code: string): Map<string, VendorExportInfo> {
    const result = new Map<string, VendorExportInfo>();

    let ast: t.File;
    try {
        ast = parse(code, {
            sourceType: "module",
            plugins: ["jsx"],
            errorRecovery: true,
        });
    } catch {
        return result;
    }

    // Step 1: Find the __commonJS import from rolldown-runtime.
    // Pattern: import { t as commonJSLocalName } from "./rolldown-runtime-*.js"
    // or: import { n as toESMLocalName, t as commonJSLocalName } from "./rolldown-runtime-*.js"
    let commonJSLocalName: string | null = null;

    for (const node of ast.program.body) {
        if (!t.isImportDeclaration(node)) continue;
        if (!node.source.value.includes("rolldown-runtime")) continue;
        for (const spec of node.specifiers) {
            if (!t.isImportSpecifier(spec)) continue;
            const imported = t.isIdentifier(spec.imported)
                ? spec.imported.name
                : (spec.imported as t.StringLiteral).value;
            // rolldown exports __commonJS as 't'
            if (imported === "t") {
                commonJSLocalName = spec.local.name;
            }
        }
    }

    // Step 2: Find all `var X = commonJSLocalName(fn)` patterns — CJS module getters.
    // Track local var name → library type
    const cjsVarToLibrary = new Map<string, "react" | "react-dom/client" | "react/jsx-runtime">();

    // wrappedBy: varName → name of the CJS var it re-exports (for chain resolution)
    const wrappedBy = new Map<string, string>();

    if (commonJSLocalName) {
        for (const node of ast.program.body) {
            if (!t.isVariableDeclaration(node)) continue;
            for (const decl of node.declarations) {
                if (!t.isIdentifier(decl.id) || !decl.init) continue;
                if (!t.isCallExpression(decl.init)) continue;
                const callee = decl.init.callee;
                if (!t.isIdentifier(callee, { name: commonJSLocalName })) continue;
                const localVarName = (decl.id as t.Identifier).name;

                const args = decl.init.arguments;
                if (args.length !== 1) continue;
                const factory = args[0];
                if (!t.isArrowFunctionExpression(factory) && !t.isFunctionExpression(factory)) continue;
                if (!t.isBlockStatement(factory.body)) continue;

                const body = factory.body.body;

                // Detect wrapper pattern: factory body contains `t.exports = Y()` somewhere.
                // Handles:
                //   - Simple: `(e, t) => { t.exports = Y() }`
                //   - With preamble: `(e, t) => { n(); t.exports = Y() }`
                //   - Sequence form: `(e, t) => { ...; n(), t.exports = Y() }`
                let wrappedVarName: string | null = null;

                const extractWrappedVar = (expr: t.Expression): string | null => {
                    if (
                        t.isAssignmentExpression(expr) &&
                        t.isMemberExpression(expr.left) &&
                        t.isIdentifier((expr.left as t.MemberExpression).property, { name: "exports" }) &&
                        t.isCallExpression(expr.right) &&
                        t.isIdentifier((expr.right as t.CallExpression).callee)
                    ) {
                        return ((expr.right as t.CallExpression).callee as t.Identifier).name;
                    }
                    // Sequence expression: (n(), t.exports = Y())
                    if (t.isSequenceExpression(expr)) {
                        for (const subExpr of expr.expressions) {
                            const v = extractWrappedVar(subExpr as t.Expression);
                            if (v) return v;
                        }
                    }
                    return null;
                };

                for (const stmt of body) {
                    if (!t.isExpressionStatement(stmt)) continue;
                    const found = extractWrappedVar(stmt.expression);
                    if (found) {
                        wrappedVarName = found;
                        break;
                    }
                }

                if (wrappedVarName) {
                    wrappedBy.set(localVarName, wrappedVarName);
                    continue; // chain resolution happens in the second pass below
                }

                // Classify this factory directly
                const libType = classifyFactory(factory as t.ArrowFunctionExpression | t.FunctionExpression);
                if (libType) {
                    cjsVarToLibrary.set(localVarName, libType);
                }
            }
        }

        // Resolve wrapper chains: wrapper → direct factory → libType
        for (const [wrapperVar, targetVar] of wrappedBy) {
            const libType = cjsVarToLibrary.get(targetVar);
            if (libType) {
                cjsVarToLibrary.set(wrapperVar, libType);
            }
        }
    }

    // Step 3: Scan for .displayName = "CanonicalName" assignments for react-router-dom components.
    // localVarName → canonicalName
    const displayNameMap = new Map<string, string>();

    traverse(ast, {
        AssignmentExpression(path) {
            const node = path.node;
            if (node.operator !== "=") return;
            const lhs = node.left;
            if (!t.isMemberExpression(lhs) || lhs.computed) return;
            if (!t.isIdentifier(lhs.property, { name: "displayName" })) return;
            if (!t.isIdentifier(lhs.object)) return;
            const rhs = node.right;
            let canonicalName: string | null = null;
            if (t.isStringLiteral(rhs)) {
                canonicalName = rhs.value;
            } else if (t.isTemplateLiteral(rhs) && rhs.expressions.length === 0 && rhs.quasis.length === 1) {
                // Template literal with no expressions: `Link` etc.
                canonicalName = rhs.quasis[0].value.cooked ?? rhs.quasis[0].value.raw;
            }
            if (canonicalName && REACT_ROUTER_DOM_CANONICAL.has(canonicalName)) {
                displayNameMap.set((lhs.object as t.Identifier).name, canonicalName);
            }
        },
    });

    // Step 4: Also detect react-router-dom exports by scanning function bodies for canonical hints.
    // For each variable declaration that is not a CJS getter, check if its body references
    // react-router-dom canonical names in backtick strings, call patterns, or JSX element names.
    const routerDomVars = new Map<string, string>(); // localVar → canonicalName

    for (const [varName, canonicalName] of displayNameMap) {
        routerDomVars.set(varName, canonicalName);
    }

    // Also scan function declarations for canonical hints
    for (const node of ast.program.body) {
        if (!t.isFunctionDeclaration(node) || !node.id) continue;
        const fnName = node.id.name;
        if (displayNameMap.has(fnName)) continue; // already found via displayName
        try {
            const bodyCode = generate(node).code;
            const canonicalName = extractRouterDomCanonical(bodyCode);
            if (canonicalName) {
                routerDomVars.set(fnName, canonicalName);
            }
        } catch {
            // skip
        }
    }

    // Step 5: Parse the export statement to build a map of exported name → local var
    // Pattern: export { localA as exportedA, localB as exportedB, ... }
    const localToExported = new Map<string, string>(); // localVarName → exportedName

    for (const node of ast.program.body) {
        if (!t.isExportNamedDeclaration(node)) continue;
        if (node.declaration) continue; // skip `export const ...`
        for (const spec of node.specifiers) {
            if (!t.isExportSpecifier(spec)) continue;
            const localName = t.isIdentifier(spec.local) ? spec.local.name : (spec.local as t.StringLiteral).value;
            const exportedName = t.isIdentifier(spec.exported)
                ? spec.exported.name
                : (spec.exported as t.StringLiteral).value;
            localToExported.set(localName, exportedName);
        }
    }

    // Step 6: Build the result map.
    // For each local var, find its exported name and classify.

    // CJS getters
    for (const [localVar, libType] of cjsVarToLibrary) {
        const exportedName = localToExported.get(localVar);
        if (!exportedName) continue;
        result.set(exportedName, {
            canonicalName: libType, // for CJS getters, canonicalName is the library path
            library: libType,
            isCjsGetter: true,
        });
    }

    // react-router-dom direct exports
    for (const [localVar, canonicalName] of routerDomVars) {
        const exportedName = localToExported.get(localVar);
        if (!exportedName) continue;
        result.set(exportedName, {
            canonicalName,
            library: "react-router-dom",
            isCjsGetter: false,
        });
    }

    // Also check for react/react-dom direct function exports (non-CJS)
    // by scanning exported vars whose body contains canonical hints
    for (const [localVar, exportedName] of localToExported) {
        if (result.has(exportedName)) continue; // already classified
        // Check if local var is a function with react-related canonical name hints
        // We do a targeted scan here for completeness
        for (const node of ast.program.body) {
            if (!t.isVariableDeclaration(node)) continue;
            for (const decl of node.declarations) {
                if (!t.isIdentifier(decl.id, { name: localVar }) || !decl.init) continue;
                try {
                    const bodyCode = generate(decl.init).code;
                    const canonicalName = extractRouterDomCanonical(bodyCode);
                    if (canonicalName) {
                        result.set(exportedName, {
                            canonicalName,
                            library: "react-router-dom",
                            isCjsGetter: false,
                        });
                    }
                } catch {
                    // skip
                }
            }
        }
    }

    return result;
}

/**
 * Extracts a react-router-dom canonical name from a code string using priority heuristics.
 * Returns the canonical name if found, null otherwise.
 */
function extractRouterDomCanonical(bodyCode: string): string | null {
    // Priority 1: backtick-quoted form inside error strings
    for (const canonical of REACT_ROUTER_DOM_CANONICAL) {
        if (bodyCode.includes("`" + canonical + "`")) return canonical;
    }
    // Priority 2: call-site mention
    for (const canonical of REACT_ROUTER_DOM_CANONICAL) {
        if (bodyCode.includes(canonical + "(")) return canonical;
    }
    // Priority 3: JSX element mention
    for (const canonical of REACT_ROUTER_DOM_CANONICAL) {
        if (bodyCode.includes("<" + canonical + ">")) return canonical;
    }
    // Priority 4: Outlet-specific
    if (bodyCode.includes(".outlet")) return "Outlet";
    // Priority 5: useParams-specific
    if (bodyCode.includes("?.params")) return "useParams";
    // Priority 6: BrowserRouter-specific
    if (bodyCode.includes("basename:")) return "BrowserRouter";
    // Priority 7: Routes-specific
    if (bodyCode.includes("children:") && bodyCode.includes("location:")) return "Routes";
    return null;
}

// Re-export canonical sets for use in the main index
export { REACT_CANONICAL, JSX_RUNTIME_CANONICAL, REACT_DOM_CLIENT_CANONICAL, REACT_ROUTER_DOM_CANONICAL };
