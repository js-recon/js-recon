import * as v8 from "v8";
import * as os from "os";
import { spawnSync } from "child_process";
import { printMsg, MSG } from "./printMsg.js";

/**
 * Re-execs the current process with the desired V8 heap limit applied via
 * --max-old-space-size.  Must be called before any significant allocation
 * (i.e. before the AST-heavy map step) so the limit is actually effective.
 *
 * @param heapMb  Target heap ceiling in MB.  0 means "use all available RAM"
 *                (os.totalmem()), which is the default when the flag is omitted.
 *                Any positive integer is used as-is.
 */
export function applyHeapLimit(heapMb: number): void {
    if (process.env.JS_RECON_HEAP_SET === "1") return;

    const targetMb = heapMb === 0 ? Math.floor(os.totalmem() / 1024 / 1024) : heapMb;

    const currentMb = Math.floor(v8.getHeapStatistics().heap_size_limit / 1024 / 1024);

    // Skip re-exec when the current limit is already within 10% of the target
    // to avoid unnecessary process churn on machines where the npm start script
    // happens to already be close to the desired value.
    if (Math.abs(targetMb - currentMb) / currentMb < 0.1) return;

    const result = spawnSync(process.execPath, [`--max-old-space-size=${targetMb}`, ...process.argv.slice(1)], {
        stdio: "inherit",
        env: { ...process.env, JS_RECON_HEAP_SET: "1" },
    });
    if (result.error) {
        printMsg(MSG.Err, `[!] Failed to re-exec with heap limit: ${result.error.message}`);
        process.exit(1);
    }
    if (result.signal) {
        // Child was killed by a signal (e.g. SIGSEGV from heap OOM).
        // Compute the conventional shell exit code (128 + signal number) so
        // callers (containers, CI) see the same code they would have without
        // the re-exec wrapper (e.g. SIGSEGV → 139, SIGKILL → 137).
        const sigNum = (os.constants.signals as Record<string, number>)[result.signal] ?? 1;
        process.exit(128 + sigNum);
    }
    process.exit(result.status ?? 1);
}
