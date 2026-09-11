import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Mirrors the "@/*" path alias from tsconfig.json so unit tests can import
// application modules the same way the app does.
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./", import.meta.url)),
      // The real package throws outside a React Server build; see the stub.
      "server-only": fileURLToPath(new URL("./test/stubs/server-only.ts", import.meta.url)),
    },
  },
  test: { include: ["**/*.test.ts"], environment: "node" },
});
