import express from "express";
import type { Express } from "express";
import http from "http";
import fs from "fs";
import { getAll, getByHostDir, requestSkip } from "./state.js";
import { buildFileTree, resolveSafePath } from "./fsBrowser.js";
import { dashboardHtml } from "./dashboardHtml.js";

const MAX_FILE_VIEW_BYTES = 5 * 1024 * 1024;
const SSE_PUSH_INTERVAL_MS = 5000;

/**
 * Tries `startPort`, then `startPort + 1`, ... until one is free (or `maxAttempts`
 * is exhausted). Returns the port the server ended up listening on.
 */
export const listenWithFallback = (
    server: http.Server,
    startPort: number,
    maxAttempts: number = 50
): Promise<number> => {
    return new Promise((resolve, reject) => {
        let attempt = 0;

        const tryListen = (port: number) => {
            const onError = (err: NodeJS.ErrnoException) => {
                server.removeListener("listening", onListening);
                if (err.code === "EADDRINUSE" && attempt < maxAttempts) {
                    attempt++;
                    tryListen(port + 1);
                } else {
                    reject(err);
                }
            };
            const onListening = () => {
                server.removeListener("error", onError);
                resolve(port);
            };
            server.once("error", onError);
            server.once("listening", onListening);
            // Loopback-only: this dashboard is a local progress viewer, never meant to be
            // reachable off-host. Binding to 127.0.0.1 is the actual mitigation for
            // unauthenticated, unrate-limited file-read routes below.
            server.listen(port, "127.0.0.1");
        };

        tryListen(startPort);
    });
};

const buildApp = (): Express => {
    const app = express();

    app.get("/", (_req, res) => {
        res.type("html").send(dashboardHtml());
    });

    app.get("/api/targets", (_req, res) => {
        res.json(getAll());
    });

    app.get("/api/events", (req, res) => {
        res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
        });

        const push = () => res.write(`data: ${JSON.stringify(getAll())}\n\n`);
        push();
        const interval = setInterval(push, SSE_PUSH_INTERVAL_MS);

        req.on("close", () => clearInterval(interval));
    });

    app.get("/api/targets/:host/files", (req, res) => {
        const target = getByHostDir(req.params.host);
        if (!target) {
            res.status(404).json({ error: "Unknown target" });
            return;
        }
        res.json(buildFileTree(target.dir));
    });

    app.get("/api/targets/:host/files/*splat", (req, res) => { // lgtm[js/missing-rate-limiting]: server binds to 127.0.0.1 only (see listenWithFallback above); no unauthenticated network-reachable surface to rate-limit.
        const target = getByHostDir(req.params.host);
        if (!target) {
            res.status(404).json({ error: "Unknown target" });
            return;
        }

        // Express 5 (path-to-regexp v6) captures a trailing `*splat` wildcard as an
        // array of path segments rather than a single string.
        const splat = (req.params as unknown as { splat: string[] }).splat;
        const relativePath = Array.isArray(splat) ? splat.join("/") : String(splat ?? "");
        const resolved = resolveSafePath(target.dir, relativePath);
        if (!resolved) {
            res.status(400).json({ error: "Invalid path" });
            return;
        }
        if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
            res.status(404).json({ error: "File not found" });
            return;
        }
        if (fs.statSync(resolved).size > MAX_FILE_VIEW_BYTES) {
            res.status(413).json({ error: "File too large to view" });
            return;
        }
        res.type("text/plain").send(fs.readFileSync(resolved, "utf-8"));
    });

    app.post("/api/targets/:host/skip", (req, res) => {
        const target = getByHostDir(req.params.host);
        if (!target) {
            res.status(404).json({ error: "Unknown target" });
            return;
        }
        requestSkip(target.url);
        res.json({ ok: true });
    });

    return app;
};

export const startDashboardServer = async (
    preferredPort: number
): Promise<{ port: number; url: string; stop: () => Promise<void> }> => {
    const app = buildApp();
    const server = http.createServer(app);
    const port = await listenWithFallback(server, preferredPort);

    const stop = (): Promise<void> =>
        new Promise((resolve) => {
            server.close(() => resolve());
        });

    return { port, url: `http://localhost:${port}`, stop };
};
