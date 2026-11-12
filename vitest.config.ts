import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@aura/protocol": path.resolve(root, "packages/protocol/src/index.ts"),
      "@aura/router": path.resolve(root, "packages/router/src/index.ts"),
      "@aura/host": path.resolve(root, "packages/host/src/index.ts"),
      "@aura/worker": path.resolve(root, "packages/worker/src/index.ts"),
    },
  },
  test: {
    globals: true,
    environment: "node",
    exclude: ["**/node_modules/**", "**/dist/**"],
  },
});
