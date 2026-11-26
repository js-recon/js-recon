import fs from "fs";
import path from "path";
import zlib from "zlib";
import * as tar from "tar";
import chalk from "chalk";

/** `--compress-js-files` types and the archive extension each one writes. */
export const COMPRESSION_TYPES: Readonly<Record<string, string>> = Object.freeze({
    tar: ".tar",
    gzip: ".tar.gz",
    brotli: ".tar.br",
    zstd: ".tar.zst",
    zip: ".zip",
});

export const COMPRESS_EXIT_CODE = 42;
// Reservation markers from run/outputDirectory.ts: they mean nothing once the directory is gone.
const SKIPPED_NAMES = new Set([".js-recon.lock", ".js-recon-output"]);

/** Exits with 42 unless `type` is a known compression type this Node can write. */
export const validateCompressionType = (type: string | undefined): void => {
    if (type === undefined) return;
    // Allowlist only: the value picks an in-process zlib/tar codec and is never passed to a shell.
    if (!Object.keys(COMPRESSION_TYPES).includes(type)) {
        console.error(
            chalk.red(
                `[!] Invalid --compress-js-files type: ${type}. Use one of: ${Object.keys(COMPRESSION_TYPES).join(", ")}`
            )
        );
        process.exit(COMPRESS_EXIT_CODE);
    }
    if (type === "zstd" && typeof (zlib as any).zstdCompressSync !== "function") {
        console.error(
            chalk.red(`[!] --compress-js-files zstd needs Node.js 22.15 or later (running ${process.version})`)
        );
        process.exit(COMPRESS_EXIT_CODE);
    }
};

// Regular files only: symlinks (and anything else that isn't a plain file or directory) are left out,
// so an archive can never carry a link that points outside the extraction directory.
const keepEntry = (name: string, stat: fs.Stats): boolean =>
    !SKIPPED_NAMES.has(path.basename(name)) && (stat.isFile() || stat.isDirectory());

/** Archive member name for `rel` under `root`; throws on anything that could land outside `root/` when extracted. */
const entryName = (root: string, rel: string): string => {
    const name = path.posix.join(root, rel.split(path.sep).join("/"));
    if (path.posix.isAbsolute(name) || name.split(/[\\/]/).includes("..") || !name.startsWith(`${root}/`))
        throw new Error(`refusing unsafe archive path ${JSON.stringify(rel)}`);
    return name;
};

const listArchiveFiles = (dir: string): string[] =>
    (fs.readdirSync(dir, { recursive: true, encoding: "utf8" }) as string[])
        .filter((f) => {
            const stat = fs.lstatSync(path.join(dir, f));
            return stat.isFile() && keepEntry(f, stat);
        })
        .sort();

const dosDateTime = (d: Date): [number, number] => [
    (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    (Math.max(d.getFullYear() - 1980, 0) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
];

// shortcut: no zip64, so at most 65,535 files and 4 GiB; add zip64 records if a target hits that.
const writeZip = (dir: string, fd: number): void => {
    const files = listArchiveFiles(dir);
    if (files.length > 0xffff) throw new Error(`${files.length} files is over the zip limit of 65535; use a tar type`);
    {
        const central: Buffer[] = [];
        let offset = 0;
        for (const rel of files) {
            const full = path.join(dir, rel);
            const data = fs.readFileSync(full);
            const packed = zlib.deflateRawSync(data);
            const name = Buffer.from(entryName(path.basename(dir), rel));
            if (offset + 30 + name.length + packed.length > 0xffffffff)
                throw new Error("archive is over the zip limit of 4 GiB; use a tar type");
            const [time, date] = dosDateTime(fs.statSync(full).mtime);
            const crc = zlib.crc32(data);
            const local = Buffer.alloc(30);
            local.writeUInt32LE(0x04034b50, 0);
            local.writeUInt16LE(20, 4);
            local.writeUInt16LE(0x0800, 6); // UTF-8 names
            local.writeUInt16LE(8, 8); // deflate
            local.writeUInt16LE(time, 10);
            local.writeUInt16LE(date, 12);
            local.writeUInt32LE(crc, 14);
            local.writeUInt32LE(packed.length, 18);
            local.writeUInt32LE(data.length, 22);
            local.writeUInt16LE(name.length, 26);
            writeAll(fd, local);
            writeAll(fd, name);
            writeAll(fd, packed);

            const entry = Buffer.alloc(46);
            entry.writeUInt32LE(0x02014b50, 0);
            entry.writeUInt16LE(20, 4);
            local.copy(entry, 6, 4, 30); // version needed .. name length are shared with the local header
            // External attributes stay 0: no Unix mode, owner or link bits are stored.
            entry.writeUInt32LE(offset, 42);
            central.push(entry, name);
            offset += 30 + name.length + packed.length;
        }
        const cd = Buffer.concat(central);
        const end = Buffer.alloc(22);
        end.writeUInt32LE(0x06054b50, 0);
        end.writeUInt16LE(files.length, 8);
        end.writeUInt16LE(files.length, 10);
        end.writeUInt32LE(cd.length, 12);
        end.writeUInt32LE(offset, 16);
        writeAll(fd, cd);
        writeAll(fd, end);
    }
};

/** fs.writeSync may write less than asked; loop until the whole buffer is on disk. */
const writeAll = (fd: number, buf: Buffer): void => {
    for (let off = 0; off < buf.length;) {
        const n = fs.writeSync(fd, buf, off, buf.length - off);
        if (n <= 0) throw new Error("archive write made no progress");
        off += n;
    }
};

const writeTar = (dir: string, type: string, fd: number): void => {
    const root = path.basename(dir);
    const pack = tar.c(
        {
            cwd: path.dirname(dir),
            sync: true,
            portable: true, // no uid/gid/user names
            preservePaths: false, // strip leading "/" and refuse ".." members
            gzip: type === "gzip",
            brotli: type === "brotli",
            zstd: type === "zstd",
            filter: (p: string, stat: fs.Stats) => {
                if (!keepEntry(p, stat)) return false;
                if (p !== root) entryName(root, path.relative(root, p));
                return true;
            },
            // Hard-linked files are stored as full copies, never as Link entries.
            linkCache: { get: () => undefined, set: () => undefined },
            // Plain 0644/0755 modes: no setuid/setgid/sticky or world-writable bits are carried over.
            onWriteEntry: (entry: any) => {
                if (entry.stat)
                    entry.stat.mode = (entry.stat.mode & ~0o7777) | (entry.stat.isDirectory() ? 0o755 : 0o644);
            },
        } as any,
        [root]
    ) as unknown as NodeJS.EventEmitter;
    pack.on("data", (chunk: Buffer) => writeAll(fd, chunk));
};

/**
 * Archives `dir` to `<dir><ext>` next to it, then deletes `dir`. An existing file at the archive path is
 * never overwritten. On failure the directory is kept, the partial archive is removed and
 * `process.exitCode` is set to 42. Returns the archive path or null.
 */
export const compressDirectory = (dir: string, type: string): string | null => {
    const source = path.resolve(dir);
    const archive = source + COMPRESSION_TYPES[type];
    let stat: fs.Stats;
    try {
        stat = fs.lstatSync(source);
    } catch {
        return null;
    }
    let fd: number | undefined;
    try {
        // Never archive through (or delete the target of) a symlinked output directory.
        if (!stat.isDirectory()) throw new Error("not a directory (symlinks are not followed)");
        // "wx" fails if anything, including a symlink, is already at the archive path: nothing is overwritten.
        fd = fs.openSync(archive, "wx", 0o600);
    } catch (err) {
        return fail(dir, type, err);
    }
    try {
        if (type === "zip") writeZip(source, fd);
        else writeTar(source, type, fd);
        fs.closeSync(fd);
        fd = undefined;
    } catch (err) {
        if (fd !== undefined) fs.closeSync(fd);
        fs.rmSync(archive, { force: true }); // only our own partial file: we created it with "wx"
        return fail(dir, type, err);
    }
    // The archive is complete from here on: if removing the directory fails part way, the archive may hold the
    // only copy of the files already removed, so it is kept.
    try {
        fs.rmSync(source, { recursive: true, force: true });
    } catch (err) {
        console.error(
            chalk.red(
                `[!] Compressed ${dir} to ${dir}${COMPRESSION_TYPES[type]} but could not remove ${dir}: ${(err as Error)?.message || err}`
            )
        );
        process.exitCode = COMPRESS_EXIT_CODE;
        return archive;
    }
    console.log(chalk.green(`[✓] Compressed ${dir} to ${dir}${COMPRESSION_TYPES[type]}`));
    return archive;
};

const fail = (dir: string, type: string, err: unknown): null => {
    console.error(chalk.red(`[!] Could not compress ${dir} (${type}), keeping it: ${(err as Error)?.message || err}`));
    process.exitCode = COMPRESS_EXIT_CODE;
    return null;
};
