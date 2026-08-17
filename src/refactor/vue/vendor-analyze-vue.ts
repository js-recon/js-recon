/**
 * Analyzes a Vue Vite main index chunk to map its minified export aliases
 * back to canonical Vue 3 runtime API names.
 *
 * Vue 3 + Vite (via @vitejs/plugin-vue) bundles the entire Vue runtime into
 * the main index chunk and re-exports only the functions the app uses, under
 * single-letter aliases:
 *
 *   export { Eu as _, qt as a, Nl as c, Pl as o }
 *
 * Each internal symbol (Eu, qt, Nl, Pl, …) is fingerprinted against known
 * Vue runtime patterns so page chunks can rewrite
 *
 *   import { _ as t, c as a, o as s } from "./index-*.js"
 *
 * into canonical imports:
 *
 *   import { _export_sfc, createElementVNode, openBlock } from "vue"
 *
 * Note: `_export_sfc` is a Vue compiler-internal helper, not part of the
 * public API. It is preserved under its conventional name so the output
 * remains recognisable.
 */

import * as parser from "@babel/parser";
import traverse from "@babel/traverse";
import _generate from "@babel/generator";
import * as t from "@babel/types";

const generate = (_generate as any).default ?? _generate;

/** Maps an export alias (e.g. `_`, `a`, `c`) to a canonical Vue name. */
export type VueExportMap = Map<string, string>;

// ---------------------------------------------------------------------------
// Pattern fingerprints
// ---------------------------------------------------------------------------

/**
 * Canonical Vue 3 runtime API names paired with a body-pattern that
 * uniquely identifies them after minification.
 *
 * Patterns are matched in order — put more specific patterns first.
 */
const VUE_PATTERNS: Array<{ canonical: string; pattern: (body: string) => boolean }> = [
    // _export_sfc: sets __vccOpts on component options (SFC compiler helper)
    { canonical: "_export_sfc", pattern: (b) => b.includes("__vccOpts") },

    // openBlock: pushes to a shared block-stack variable
    { canonical: "openBlock", pattern: (b) => b.includes("kt.push") || b.includes(".push(be=") },

    // createElementBlock: delegates to createBaseVNode with block flag
    {
        canonical: "createElementBlock",
        pattern: (b) => b.includes("Il(qt(") || (b.includes("Il(") && b.includes(",!0)")),
    },

    // createElementVNode: similar to createElementBlock but different flag
    {
        canonical: "createElementVNode",
        pattern: (b) =>
            (b.includes("Il(") || b.includes("Kl(")) && !b.includes("__v_isVNode") && !b.includes("__vccOpts"),
    },

    // createBaseVNode / createVNode: core VNode factory — creates the {__v_isVNode: true} object
    {
        canonical: "createBaseVNode",
        pattern: (b) => b.includes("__v_isVNode:!0") || b.includes("__v_isVNode: !0") || b.includes("__v_isVNode:true"),
    },

    // createTextVNode: short function that creates a text vnode
    { canonical: "createTextVNode", pattern: (b) => b.includes("__v_isVNode") && b.length < 200 },

    // createCommentVNode: creates a comment/placeholder vnode
    {
        canonical: "createCommentVNode",
        pattern: (b) => b.includes("<!--") || b.includes("createCommentVNode") || b.includes("comment"),
    },

    // withCtx: wraps slot render functions in the parent render context
    {
        canonical: "withCtx",
        pattern: (b) =>
            b.includes("renderCache") ||
            b.includes("withCtx") ||
            b.includes("setCurrentRenderingInstance") ||
            b.includes("currentRenderingInstance"),
    },

    // normalizeClass: normalizes a class value to string
    {
        canonical: "normalizeClass",
        pattern: (b) => b.includes("normalizeClass") || (b.includes("Array.isArray") && b.includes("join")),
    },

    // normalizeStyle: normalizes style value
    { canonical: "normalizeStyle", pattern: (b) => b.includes("normalizeStyle") },

    // toDisplayString: converts a value to its string representation
    {
        canonical: "toDisplayString",
        pattern: (b) =>
            b.includes("toDisplayString") || (b.includes("isString") && b.includes("isArray") && b.length < 300),
    },

    // mergeProps: merges multiple prop objects
    { canonical: "mergeProps", pattern: (b) => b.includes("mergeProps") || b.includes("onUpdate:") },

    // resolveComponent: resolves component by name at runtime
    {
        canonical: "resolveComponent",
        pattern: (b) =>
            b.includes("resolveComponent") || (b.includes("currentRenderingInstance") && b.includes("appContext")),
    },

    // withDirectives: applies custom directives to a vnode
    { canonical: "withDirectives", pattern: (b) => b.includes("withDirectives") || b.includes("invokeDirectiveHook") },

    // vModelText / vModelCheckbox / vModelSelect: v-model directives
    {
        canonical: "vModelText",
        pattern: (b) => b.includes("vModelText") || (b.includes("composing") && b.includes("input")),
    },
    {
        canonical: "vModelCheckbox",
        pattern: (b) => b.includes("vModelCheckbox") || (b.includes("checkbox") && b.includes("checked")),
    },
    {
        canonical: "vModelSelect",
        pattern: (b) => b.includes("vModelSelect") || (b.includes("select") && b.includes("options")),
    },

    // renderList: renders a v-for list
    {
        canonical: "renderList",
        pattern: (b) =>
            b.includes("renderList") ||
            (b.includes("isArray") && b.includes("isString") && b.includes("isInteger") && b.includes("isObject")),
    },

    // Fragment: the Fragment symbol
    { canonical: "Fragment", pattern: (b) => b.includes("Fragment") },

    // ref / reactive / computed: reactivity API
    { canonical: "ref", pattern: (b) => b.includes("RefImpl") || (b.includes("__v_isRef") && b.length < 400) },
    { canonical: "reactive", pattern: (b) => b.includes("reactive") && b.includes("Proxy") },
    {
        canonical: "computed",
        pattern: (b) =>
            b.includes("ComputedRefImpl") || (b.includes("getter") && b.includes("setter") && b.length < 800),
    },
];

// Public Vue 3 API names — used to decide whether a canonical name gets imported from 'vue'.
// _export_sfc is NOT in the public API; it is inlined as a local helper.
export const VUE_PUBLIC_API = new Set([
    "openBlock",
    "createElementBlock",
    "createElementVNode",
    "createBaseVNode",
    "createVNode",
    "createTextVNode",
    "createCommentVNode",
    "createBlock",
    "withCtx",
    "normalizeClass",
    "normalizeStyle",
    "toDisplayString",
    "mergeProps",
    "resolveComponent",
    "withDirectives",
    "vModelText",
    "vModelCheckbox",
    "vModelSelect",
    "renderList",
    "Fragment",
    "ref",
    "reactive",
    "computed",
    "onMounted",
    "onUpdated",
    "onUnmounted",
    "watch",
    "watchEffect",
    "defineComponent",
    "defineAsyncComponent",
    "provide",
    "inject",
    "useSlots",
    "useAttrs",
    "Transition",
    "TransitionGroup",
    "KeepAlive",
    "Teleport",
    "Suspense",
]);

// ---------------------------------------------------------------------------
// Main analysis function
// ---------------------------------------------------------------------------

/**
 * Parses the Vue main index chunk and returns a map of:
 *   export-alias → canonical Vue name
 *
 * e.g. { "_": "_export_sfc", "a": "createBaseVNode", "c": "createElementVNode", "o": "openBlock" }
 *
 * Returns an empty map if the chunk cannot be parsed or does not look like a
 * Vue bundle (no export statement with the `__vccOpts` pattern).
 */
export function analyzeVueIndexChunk(code: string): VueExportMap {
    const result: VueExportMap = new Map();

    // Quick sanity check: must contain __vccOpts (SFC helper marker)
    if (!code.includes("__vccOpts")) return result;

    let ast: t.File;
    try {
        ast = parser.parse(code, {
            sourceType: "module",
            plugins: ["jsx"],
            errorRecovery: true,
        });
    } catch {
        return result;
    }

    // Step 1: Find the export statement and build alias→internal map.
    // export { Eu as _, qt as a, Nl as c, Pl as o }
    const aliasToInternal = new Map<string, string>(); // "_" → "Eu"

    traverse(ast, {
        ExportNamedDeclaration(path) {
            const node = path.node;
            if (node.declaration || node.source) return;
            for (const spec of node.specifiers) {
                if (!t.isExportSpecifier(spec)) continue;
                const local = t.isIdentifier(spec.local) ? spec.local.name : null;
                const exported = t.isIdentifier(spec.exported)
                    ? spec.exported.name
                    : t.isStringLiteral(spec.exported)
                      ? spec.exported.value
                      : null;
                if (local && exported) {
                    aliasToInternal.set(exported, local); // "_" → "Eu"
                }
            }
            path.stop();
        },
    });

    if (aliasToInternal.size === 0) return result;

    // Step 2: For each internal name, extract the function/arrow body as a string
    // and fingerprint it.
    const internalToBody = new Map<string, string>(); // "Eu" → "const n=e.__vccOpts..."

    traverse(ast, {
        VariableDeclarator(path) {
            const node = path.node;
            if (!t.isIdentifier(node.id)) return;
            const name = node.id.name;
            if (!isRelevantInternal(name, aliasToInternal)) return;
            const body = node.init ? generate(node.init).code : "";
            internalToBody.set(name, body);
        },
        FunctionDeclaration(path) {
            const node = path.node;
            if (!node.id) return;
            const name = node.id.name;
            if (!isRelevantInternal(name, aliasToInternal)) return;
            const body = generate(node).code;
            internalToBody.set(name, body);
        },
    });

    // Step 3: Fingerprint each internal name against Vue patterns.
    for (const [alias, internal] of aliasToInternal) {
        const body = internalToBody.get(internal) ?? "";
        for (const { canonical, pattern } of VUE_PATTERNS) {
            if (pattern(body)) {
                result.set(alias, canonical);
                break;
            }
        }
        // If nothing matched, store the internal name as a fallback.
        if (!result.has(alias)) {
            result.set(alias, internal);
        }
    }

    return result;
}

function isRelevantInternal(name: string, aliasToInternal: Map<string, string>): boolean {
    for (const internal of aliasToInternal.values()) {
        if (internal === name) return true;
    }
    return false;
}
