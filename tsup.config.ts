import { defineConfig } from "tsup";

export default defineConfig({
    entry: ["src/roulette.ts"],
    publicDir: false,
    clean: true,
    minify: true,
    format: ["cjs"], // 👈 Node
    // https-proxy-agent is ESM-only, so a CJS bundle cannot require() it on Node
    // versions without require(esm). Inline it instead of leaving it external.
    noExternal: ["https-proxy-agent"],
});