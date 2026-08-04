import fs from "fs";
import path from "path";
import parser from "@babel/parser";
import _traverse from "@babel/traverse";
import { printMsg, MSG } from "../../utility/printMsg.js";
import {
    parse as gqlParse,
    print as gqlPrint,
    Kind,
    type DocumentNode,
    type OperationDefinitionNode,
    type FragmentDefinitionNode,
    type TypeNode,
    type VariableDefinitionNode,
} from "graphql";
import * as globals from "../../utility/globals.js";

const traverse = (_traverse.default ?? _traverse) as typeof _traverse.default;

const OPERATION_TOKEN_RE = /\b(query|mutation|subscription|fragment)\b/;
const MIN_CANDIDATE_LEN = 20;

/**
 * Convert a TemplateLiteral AST node into a cooked string with each
 * interpolation replaced by a neutral placeholder. We use a short alphanumeric
 * filler rather than `${...}` because the GraphQL parser would reject the
 * literal `$` syntax. Interpolations inside GraphQL templates almost always
 * sit at value positions (variable defaults, enum names) where a placeholder
 * may or may not parse — failures are silently dropped at the parse stage.
 */
const templateLiteralToString = (node: any): string => {
    if (!node || !Array.isArray(node.quasis)) return "";
    const parts: string[] = [];
    for (let i = 0; i < node.quasis.length; i++) {
        const q = node.quasis[i];
        const cooked = q?.value?.cooked ?? q?.value?.raw ?? "";
        parts.push(cooked);
        if (i < node.quasis.length - 1) {
            parts.push("__jsrecon_interp__");
        }
    }
    return parts.join("");
};

/**
 * Maps a GraphQL variable type AST node onto an example value that follows
 * the existing `<string>` / `<number>` / `<boolean>` placeholder convention
 * already understood by openapiGenerator's getZodPlaceholderType().
 */
const placeholderForType = (typeNode: TypeNode): any => {
    if (typeNode.kind === Kind.NON_NULL_TYPE) {
        return placeholderForType(typeNode.type);
    }
    if (typeNode.kind === Kind.LIST_TYPE) {
        return [placeholderForType(typeNode.type)];
    }
    const name = typeNode.name.value;
    switch (name) {
        case "String":
        case "ID":
            return "<string>";
        case "Int":
        case "Float":
            return "<number>";
        case "Boolean":
            return "<boolean>";
        default:
            return "<string>";
    }
};

const buildVariablesStub = (defs: ReadonlyArray<VariableDefinitionNode> | undefined): Record<string, any> => {
    const out: Record<string, any> = {};
    if (!defs) return out;
    for (const def of defs) {
        out[def.variable.name.value] = placeholderForType(def.type);
    }
    return out;
};

/**
 * Captures candidate strings from a JS file's AST. We look at StringLiteral
 * and TemplateLiteral nodes only — both directly carry GraphQL source text in
 * real-world bundles (plain strings from `gql("…")` calls and inlined
 * mutation/query exports; template literals from `gql\`…\``).
 */
const collectCandidates = (code: string): Array<{ source: string; line: number }> => {
    const candidates: Array<{ source: string; line: number }> = [];
    let ast: any;
    try {
        ast = parser.parse(code, {
            sourceType: "unambiguous",
            allowReturnOutsideFunction: true,
            allowAwaitOutsideFunction: true,
            allowImportExportEverywhere: true,
            errorRecovery: true,
            plugins: ["jsx", "typescript"],
        });
    } catch {
        return candidates;
    }

    const seenInFile = new Set<string>();
    traverse(ast, {
        StringLiteral(p: any) {
            const v = p.node.value;
            if (typeof v !== "string" || v.length < MIN_CANDIDATE_LEN) return;
            if (!OPERATION_TOKEN_RE.test(v)) return;
            if (seenInFile.has(v)) return;
            seenInFile.add(v);
            candidates.push({ source: v, line: p.node.loc?.start?.line ?? 0 });
        },
        TemplateLiteral(p: any) {
            const v = templateLiteralToString(p.node);
            if (v.length < MIN_CANDIDATE_LEN) return;
            if (!OPERATION_TOKEN_RE.test(v)) return;
            if (seenInFile.has(v)) return;
            seenInFile.add(v);
            candidates.push({ source: v, line: p.node.loc?.start?.line ?? 0 });
        },
    });

    return candidates;
};

const tryParse = (source: string): DocumentNode | null => {
    try {
        return gqlParse(source, { noLocation: true });
    } catch {
        return null;
    }
};

/**
 * Re-prints a single operation as a standalone document, inlining any
 * fragment definitions referenced from the operation so the emitted query
 * body is self-contained.
 */
const printOperationStandalone = (
    op: OperationDefinitionNode,
    fragments: Map<string, FragmentDefinitionNode>
): string => {
    const referenced = new Set<string>();
    const visit = (node: any): void => {
        if (!node || typeof node !== "object") return;
        if (node.kind === Kind.FRAGMENT_SPREAD && node?.name?.value) {
            referenced.add(node.name.value);
        }
        for (const key of Object.keys(node)) {
            const child = (node as any)[key];
            if (Array.isArray(child)) child.forEach(visit);
            else if (child && typeof child === "object" && child.kind) visit(child);
        }
    };
    visit(op);

    // Transitively pull in fragments that reference other fragments
    const out: FragmentDefinitionNode[] = [];
    const queue = Array.from(referenced);
    const added = new Set<string>();
    while (queue.length > 0) {
        const name = queue.shift()!;
        if (added.has(name)) continue;
        const frag = fragments.get(name);
        if (!frag) continue;
        added.add(name);
        out.push(frag);
        visit(frag);
        for (const ref of referenced) {
            if (!added.has(ref) && !queue.includes(ref)) queue.push(ref);
        }
    }

    const doc: DocumentNode = { kind: Kind.DOCUMENT, definitions: [op, ...out] } as DocumentNode;
    return gqlPrint(doc);
};

/**
 * Scans every JS file under `directory` for embedded GraphQL operations and
 * emits one OpenAPI POST entry per distinct operation under a flat
 * `GraphQL` collection folder. The endpoint URL is parameterised via the
 * `{{graphqlEndpoint}}` placeholder so importers can substitute the real
 * path at import time — this resolver does not attempt to locate the
 * transport URL in the bundle.
 */
const resolveGraphql = async (directory: string): Promise<void> => {
    printMsg(MSG.Header, "[i] Scanning for embedded GraphQL operations");

    let files: string[];
    try {
        files = fs.readdirSync(directory, { recursive: true, encoding: "utf8" }) as string[];
    } catch {
        printMsg(MSG.Err, `[!] Could not read directory: ${directory}`);
        return;
    }

    files = files.filter((f) => f.endsWith(".js") || f.endsWith(".mjs"));
    const total = files.length;
    printMsg(MSG.Header, `[i] Scanning ${total} JS file(s) for GraphQL operations`);

    // Two-phase to handle fragment-only files: first collect ALL fragments
    // across all files, then emit operations with their fragment closures.
    const allFragments = new Map<string, FragmentDefinitionNode>();
    interface PendingOp {
        op: OperationDefinitionNode;
        filePath: string;
        line: number;
    }
    const pendingOps: PendingOp[] = [];

    let lastPct = -1;
    const startTs = Date.now();

    for (let i = 0; i < total; i++) {
        if (i > 0 && i % 50 === 0) await new Promise<void>((r) => setImmediate(r));
        const pct = total === 0 ? 100 : Math.floor(((i + 1) * 100) / total);
        if (pct !== lastPct && (pct % 10 === 0 || pct === 100)) {
            const elapsed = ((Date.now() - startTs) / 1000).toFixed(1);
            printMsg(
                MSG.Info,
                `    [scan] ${pct}% (${i + 1}/${total}) ops=${pendingOps.length} fragments=${allFragments.size} elapsed=${elapsed}s`
            );
            lastPct = pct;
        }

        const rel = files[i];
        const filePath = path.join(directory, rel);
        let stat: fs.Stats;
        try {
            stat = fs.lstatSync(filePath);
        } catch {
            continue;
        }
        if (stat.isDirectory()) continue;

        let content: string;
        try {
            content = fs.readFileSync(filePath, "utf-8");
        } catch {
            continue;
        }
        if (!OPERATION_TOKEN_RE.test(content)) continue;

        const candidates = collectCandidates(content);
        for (const c of candidates) {
            const doc = tryParse(c.source);
            if (!doc) continue;
            for (const def of doc.definitions) {
                if (def.kind === Kind.OPERATION_DEFINITION) {
                    pendingOps.push({ op: def, filePath, line: c.line });
                } else if (def.kind === Kind.FRAGMENT_DEFINITION) {
                    const name = def.name.value;
                    if (!allFragments.has(name)) allFragments.set(name, def);
                }
            }
        }
    }

    const emittedKeys = new Set<string>();
    let emitted = 0;
    let anonCounter = 0;

    for (const { op, filePath, line } of pendingOps) {
        const printedQuery = printOperationStandalone(op, allFragments);
        const operationName = op.name?.value;
        const variables = buildVariablesStub(op.variableDefinitions);

        const bodyObj: Record<string, any> = { query: printedQuery };
        if (operationName) bodyObj.operationName = operationName;
        if (Object.keys(variables).length > 0) bodyObj.variables = variables;

        // Dedupe key: normalized query + operationName. A fragment used by
        // multiple operations still produces distinct entries because the
        // surrounding operation differs.
        const dedupeKey = `${operationName ?? ""}::${printedQuery}`;
        if (emittedKeys.has(dedupeKey)) continue;
        emittedKeys.add(dedupeKey);

        const summary = operationName ?? `anonymous ${op.operation} #${++anonCounter}`;

        globals.addOpenapiOutput({
            url: "/{{graphqlEndpoint}}",
            method: "POST",
            path: "/{{graphqlEndpoint}}",
            headers: {
                "Content-Type": "application/json",
                Accept: "application/json",
            },
            body: JSON.stringify(bodyObj),
            chunkId: "",
            functionFile: filePath,
            functionFileLine: line,
            summary,
            collectionFolder: "GraphQL",
        });
        emitted++;
    }

    printMsg(
        MSG.Run,
        `[✓] GraphQL: emitted ${emitted} operation(s) from ${allFragments.size} fragment(s) and ${pendingOps.length} parsed operation(s)`
    );
};

export default resolveGraphql;
