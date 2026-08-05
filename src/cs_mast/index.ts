import { cs_mast_init, ParseError, buildSignatureFromConfig } from "@shriyanss/cs-mast";
import type { CsMastConfig, ScatCategory } from "@shriyanss/cs-mast";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { printMsg, MSG } from "../utility/printMsg.js";

const CS_MAST_CONFIG: CsMastConfig = {
    hash: "sha256",
    lang: "js",
    prsr: "@babel/parser",
    scat: ["lit", "decl", "loop", "cond"] as ScatCategory[],
    sinc: [],
    sourceType: "unambiguous",
};

function findJsFiles(dir: string): string[] {
    const results: string[] = [];
    if (!fs.existsSync(dir)) return results;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            results.push(...findJsFiles(full));
        } else if (entry.isFile() && entry.name.endsWith(".js")) {
            results.push(full);
        }
    }
    return results;
}

interface CollisionEntry {
    signature: string;
    count: number;
    files: string[];
}

const ALL_SCAT: ScatCategory[] = ["lit", "decl", "loop", "cond", "id", "op", "name", "val", "op_name"];

function allScatSubsets(): ScatCategory[][] {
    const result: ScatCategory[][] = [];
    for (let mask = 1; mask < 1 << ALL_SCAT.length; mask++) {
        const subset: ScatCategory[] = [];
        for (let i = 0; i < ALL_SCAT.length; i++) {
            if (mask & (1 << i)) subset.push(ALL_SCAT[i]);
        }
        result.push(subset);
    }
    return result;
}

async function runOnePermutation(
    jsFiles: string[],
    scat: ScatCategory[],
    sinc: ScatCategory[],
    minCollisions: number,
    permOutput: string,
    collisionFormat: string
): Promise<void> {
    const cfg: CsMastConfig = {
        hash: "sha256",
        lang: "js",
        prsr: "@babel/parser",
        scat,
        sinc,
        sourceType: "unambiguous",
    };
    const sigMap = new Map<string, string[]>();
    for (const file of jsFiles) {
        try {
            const source = fs.readFileSync(file, "utf-8");
            const tree = cs_mast_init(source, cfg);
            const sig = buildSignatureFromConfig(cfg, tree.rootHash);
            if (!sigMap.has(sig)) sigMap.set(sig, []);
            sigMap.get(sig)!.push(file);
        } catch {
            // parse errors are silent in permutation mode
        }
    }
    const collisions: CollisionEntry[] = [...sigMap.entries()]
        .filter(([, files]) => files.length >= minCollisions)
        .sort(([, a], [, b]) => b.length - a.length)
        .map(([signature, files]) => ({ signature, count: files.length, files }));
    if (collisions.length === 0) return;
    const name = scat.join("-");
    const outFile = path.join(permOutput, `${name}.${collisionFormat}`);
    if (collisionFormat === "json") {
        fs.writeFileSync(outFile, JSON.stringify(collisions, null, 2));
    } else {
        const rows = ["signature,count,files"];
        for (const entry of collisions) rows.push(`"${entry.signature}",${entry.count},"${entry.files.join("|")}"`);
        fs.writeFileSync(outFile, rows.join("\n"));
    }
}

export default async (
    outputDir: string,
    collisionTable: boolean,
    minCollisions: number,
    collisionOutput: string | undefined,
    collisionFormat: string,
    scatOverride: string = "",
    sincOverride: string = "",
    allPermutations: boolean = false,
    permOutput: string | undefined = undefined,
    permConcurrency: number = 0
): Promise<void> => {
    if (collisionOutput && !["json", "csv"].includes(collisionFormat)) {
        printMsg(MSG.Err, `[!] Invalid format: "${collisionFormat}". Use "json" or "csv".`);
        process.exit(1);
    }

    // Resolve output path: if it's an existing directory or has no extension,
    // write collisions.<fmt> in the current working directory.
    if (collisionOutput) {
        if (
            (fs.existsSync(collisionOutput) && fs.statSync(collisionOutput).isDirectory()) ||
            !path.extname(collisionOutput)
        ) {
            collisionOutput = `collisions.${collisionFormat}`;
        }
    }

    if (!fs.existsSync(outputDir)) {
        printMsg(MSG.Err, `[!] Output directory not found: ${outputDir}`);
        process.exit(1);
    }

    // apply scat/sinc overrides
    const activeScat: ScatCategory[] = scatOverride
        ? (scatOverride
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean) as ScatCategory[])
        : (CS_MAST_CONFIG.scat as ScatCategory[]);
    const activeSinc: ScatCategory[] = sincOverride
        ? (sincOverride
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean) as ScatCategory[])
        : [];
    const activeConfig: CsMastConfig = { ...CS_MAST_CONFIG, scat: activeScat, sinc: activeSinc };

    printMsg(MSG.Header, `[*] Scanning JS files in: ${outputDir}`);
    const jsFiles = findJsFiles(outputDir);
    printMsg(MSG.Header, `[*] Found ${jsFiles.length} JS file(s)`);

    // --all-scat-permutations mode
    if (allPermutations) {
        if (!permOutput) {
            printMsg(MSG.Err, "[!] --perm-output <dir> is required with --all-scat-permutations");
            process.exit(1);
        }
        if (!fs.existsSync(permOutput)) fs.mkdirSync(permOutput, { recursive: true });
        const subsets = allScatSubsets();
        const concurrency =
            permConcurrency > 0 ? permConcurrency : Math.max(1, Math.floor(os.cpus().length / 2));
        printMsg(MSG.Header, `[*] Running ${subsets.length} scat permutations (concurrency: ${concurrency})`);
        let done = 0;
        for (let i = 0; i < subsets.length; i += concurrency) {
            const batch = subsets.slice(i, i + concurrency);
            await Promise.all(
                batch.map((scat) =>
                    runOnePermutation(jsFiles, scat, activeSinc, minCollisions, permOutput!, collisionFormat)
                )
            );
            done += batch.length;
            process.stdout.write(`\r[*] ${done}/${subsets.length} permutations done`);
        }
        printMsg(MSG.Run, `\n[+] All permutations written to: ${permOutput}`);
        return;
    }

    const sigMap = new Map<string, string[]>();
    let parsed = 0;
    let skipped = 0;

    for (const file of jsFiles) {
        try {
            const source = fs.readFileSync(file, "utf-8");
            const tree = cs_mast_init(source, activeConfig);
            // rootSignature is empty when the File node isn't actively hashed;
            // build the full PHC string from rootHash + config instead.
            const sig = buildSignatureFromConfig(activeConfig, tree.rootHash);
            if (!sigMap.has(sig)) sigMap.set(sig, []);
            sigMap.get(sig)!.push(file);
            parsed++;
        } catch (e) {
            if (e instanceof ParseError) {
                printMsg(MSG.Warn, `[!] Skipping (parse error): ${file}`);
            }
            skipped++;
        }
    }

    printMsg(MSG.Run, `[+] Processed ${parsed} file(s), skipped ${skipped}, unique hashes: ${sigMap.size}`);

    if (!collisionTable && !collisionOutput) return;

    const collisions: CollisionEntry[] = [...sigMap.entries()]
        .filter(([, files]) => files.length >= minCollisions)
        .sort(([, a], [, b]) => b.length - a.length)
        .map(([signature, files]) => ({ signature, count: files.length, files }));

    if (collisions.length === 0) {
        printMsg(MSG.Warn, `[!] No collisions found with --min-collisions ${minCollisions}`);
        return;
    }

    if (collisionTable) {
        printMsg(MSG.Run, `\n[+] ${collisions.length} collision group(s) found (min-collisions: ${minCollisions}):\n`);

        const sigColWidth = 60;
        const countColWidth = 7;
        const header = "Signature".padEnd(sigColWidth) + "Count".padEnd(countColWidth) + "Files";
        const separator = "─".repeat(sigColWidth) + "─".repeat(countColWidth) + "─".repeat(40);

        printMsg(MSG.Plain, header);
        printMsg(MSG.Plain, separator);

        for (const entry of collisions) {
            // Truncate at the hash boundary: show params + first 12 hex chars
            const truncated =
                entry.signature.length > sigColWidth - 1
                    ? entry.signature.slice(0, sigColWidth - 4) + "..."
                    : entry.signature;
            const fileList = entry.files.join(", ");
            printMsg(MSG.Plain, truncated.padEnd(sigColWidth) + String(entry.count).padEnd(countColWidth) + fileList);
        }
    }

    if (!collisionOutput) return;

    if (collisionFormat === "json") {
        fs.writeFileSync(collisionOutput, JSON.stringify(collisions, null, 2));
    } else {
        const rows = ["signature,count,files"];
        for (const entry of collisions) {
            rows.push(`"${entry.signature}",${entry.count},"${entry.files.join("|")}"`);
        }
        fs.writeFileSync(collisionOutput, rows.join("\n"));
    }

    printMsg(MSG.Run, `[+] Collision data written to: ${collisionOutput}`);
};
