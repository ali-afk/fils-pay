import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@filspay/money": fileURLToPath(new URL("../../packages/money/src/index.ts", import.meta.url)),
    },
  },
  server: {
    // apps/web already owns 5173.
    port: 5174,
  },
});
