import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        environment: "node",
        include: ["src/**/*.fuzz.test.ts"],
        testTimeout: 30000,
    },
});
