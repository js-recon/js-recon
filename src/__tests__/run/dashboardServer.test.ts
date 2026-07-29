import { describe, it, expect, afterEach } from "vitest";
import http from "http";
import { listenWithFallback } from "../../run/dashboard/server.js";

describe("listenWithFallback", () => {
    const servers: http.Server[] = [];

    afterEach(async () => {
        await Promise.all(
            servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve())))
        );
    });

    it("listens directly on the preferred port when it's free", async () => {
        const server = http.createServer();
        servers.push(server);
        const port = await listenWithFallback(server, 0); // port 0 = OS-assigned free port
        expect(port).toBe(0);
        expect((server.address() as any).port).toBeGreaterThan(0);
    });

    it("increments to the next free port when the preferred one is taken", async () => {
        const occupier = http.createServer();
        servers.push(occupier);
        const occupiedPort: number = await new Promise((resolve) => {
            occupier.listen(0, () => resolve((occupier.address() as any).port));
        });

        const server = http.createServer();
        servers.push(server);
        const port = await listenWithFallback(server, occupiedPort, 5);

        expect(port).toBeGreaterThan(occupiedPort);
    });

    it("rejects when every attempted port is taken", async () => {
        const occupier = http.createServer();
        servers.push(occupier);
        const occupiedPort: number = await new Promise((resolve) => {
            occupier.listen(0, () => resolve((occupier.address() as any).port));
        });

        const server = http.createServer();
        servers.push(server);
        // maxAttempts: 0 means only the initial (occupied) port is tried, no fallback
        await expect(listenWithFallback(server, occupiedPort, 0)).rejects.toThrow();
    });
});
