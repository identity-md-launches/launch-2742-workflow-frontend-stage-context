import { defineConfig } from "vite";

// Relative base so the export works from an IPFS gateway subpath or an ENS name.
export default defineConfig({
  base: "./",
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 2000,
  },
  test: {
    environment: "jsdom",
    include: ["test/**/*.test.ts"],
  },
} as any);
