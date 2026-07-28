import parser from "@babel/parser";
import _generator from "@babel/generator";
import * as t from "@babel/types";
import { printMsg, MSG } from "../../utility/printMsg.js";

const generate = (_generator.default ?? _generator) as typeof _generator.default;

export const MAX_FIX_ITERATIONS = 10;

export const tryStrictParse = (code: string): parser.ParseError[] => {
    try {
        parser.parse(code, {
            sourceType: "module",
            plugins: ["jsx"],
            errorRecovery: false,
        });
        return [];
    } catch (err: any) {
        return [err as parser.ParseError];
    }
};

export const applyFixes = (code: string, statements: t.Statement[]): t.Statement[] => {
    let recoveredAst: t.File;
    try {
        recoveredAst = parser.parse(code, {
            sourceType: "module",
            plugins: ["jsx"],
            errorRecovery: true,
        });
    } catch {
        return statements.slice(0, -1);
    }

    const parseErrors: Array<{ line: number; col: number }> = ((recoveredAst as any).errors ?? []).map((e: any) => ({
        line: e.loc?.line ?? 0,
        col: e.loc?.column ?? 0,
    }));

    if (parseErrors.length === 0) return statements;

    let lineOffset = 0;
    const stmtLineRanges: Array<{ start: number; end: number }> = [];
    for (const stmt of statements) {
        const stmtCode = generate(stmt as any).code;
        const lineCount = stmtCode.split("\n").length;
        stmtLineRanges.push({ start: lineOffset + 1, end: lineOffset + lineCount });
        lineOffset += lineCount;
    }

    const errorStmtIndices = new Set<number>();
    for (const err of parseErrors) {
        for (let i = 0; i < stmtLineRanges.length; i++) {
            if (err.line >= stmtLineRanges[i].start && err.line <= stmtLineRanges[i].end) {
                errorStmtIndices.add(i);
                break;
            }
        }
    }

    const out: t.Statement[] = [];
    for (let i = 0; i < statements.length; i++) {
        const stmt = statements[i];
        if (!errorStmtIndices.has(i)) {
            out.push(stmt);
            continue;
        }

        // Downgrade `export { ident as "StringKey" }` to `export const StringKey = ident`.
        if (
            t.isExportNamedDeclaration(stmt) &&
            !stmt.declaration &&
            stmt.specifiers.length === 1 &&
            t.isExportSpecifier(stmt.specifiers[0]) &&
            t.isStringLiteral((stmt.specifiers[0] as t.ExportSpecifier).exported)
        ) {
            const spec = stmt.specifiers[0] as t.ExportSpecifier;
            const propName = (spec.exported as t.StringLiteral).value;
            const local = spec.local as t.Identifier;
            out.push(
                t.exportNamedDeclaration(
                    t.variableDeclaration("const", [t.variableDeclarator(t.identifier(propName), local)])
                )
            );
            continue;
        }

        // Downgrade `export function name() { ... }` to `export const name = function() { ... }`.
        if (
            t.isExportNamedDeclaration(stmt) &&
            stmt.declaration &&
            t.isFunctionDeclaration(stmt.declaration) &&
            stmt.declaration.id
        ) {
            const fn = stmt.declaration as t.FunctionDeclaration;
            out.push(
                t.exportNamedDeclaration(
                    t.variableDeclaration("const", [
                        t.variableDeclarator(
                            fn.id!,
                            t.functionExpression(null, fn.params, fn.body, fn.generator, fn.async)
                        ),
                    ])
                )
            );
            continue;
        }

        printMsg(
            MSG.Warn,
            `    [~] Dropping unresolvable statement at index ${i}: ${generate(stmt as any)
                .code.slice(0, 80)
                .replace(/\s+/g, " ")}`
        );
    }
    return out;
};

export const validateAndFix = (statements: t.Statement[], moduleId: string): string | null => {
    let current = [...statements];

    for (let attempt = 0; attempt <= MAX_FIX_ITERATIONS; attempt++) {
        const programNode = t.program(current, [], "module");
        const code = generate(programNode as any).code;
        const errors = tryStrictParse(code);

        if (errors.length === 0) return code;

        if (attempt === MAX_FIX_ITERATIONS) {
            printMsg(
                MSG.Err,
                `[!] Module ${moduleId} could not be fixed after ${MAX_FIX_ITERATIONS} attempts — skipping`
            );
            return null;
        }

        for (const err of errors) {
            const loc = (err as any).loc ? ` at line ${(err as any).loc.line}, col ${(err as any).loc.column}` : "";
            printMsg(MSG.Err, `[!] Syntax error in module ${moduleId} (attempt ${attempt + 1}/${MAX_FIX_ITERATIONS}):`);
            printMsg(MSG.Err, `    ${(err as any).message}${loc}`);
            if ((err as any).codeFrame) printMsg(MSG.Plain, (err as any).codeFrame);
        }

        current = applyFixes(code, current);
    }

    return null;
};
