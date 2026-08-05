import tseslint from "typescript-eslint";
import security from "eslint-plugin-security";

export default tseslint.config(
    {
        ignores: ["build/**", "output/**", "output_refactored/**", "node_modules/**"],
    },
    {
        files: ["src/**/*.ts"],
        extends: [...tseslint.configs.recommended],
        plugins: {
            security,
        },
        rules: {
            ...security.configs.recommended.rules,
            // These fire on legitimate dynamic-code patterns intrinsic to a bundle-analysis tool
            // (parsing/instrumenting untrusted third-party JS is the entire point of js-recon).
            "security/detect-non-literal-fs-filename": "off",
            "security/detect-object-injection": "off",
            "@typescript-eslint/no-explicit-any": "off",
            "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
        },
    },
);
