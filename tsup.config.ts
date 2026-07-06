import { defineConfig } from "tsup";

export default defineConfig({
    format: ["cjs", "esm"],
    entry: ["./src/index.ts", "./src/cli/start-whisper.ts"],
    dts: true,
    shims: true,
    skipNodeModulesBundle: true,
    clean: true,
    // With multiple entry points esbuild code-splits shared modules into
    // chunks that are imported BEFORE src/index.ts's own `import "dotenv/config"`,
    // so module-scope process.env reads in those chunks saw an empty env.
    // Prepending the dotenv side-effect import to every emitted file (chunks
    // included) guarantees .env is loaded before any bundled code evaluates.
    esbuildOptions(options, context) {
        const loadEnv =
            context.format === "esm"
                ? 'import "dotenv/config";'
                : 'require("dotenv/config");';
        options.banner = {
            ...options.banner,
            js: [loadEnv, options.banner?.js].filter(Boolean).join("\n"),
        };
    },
});
