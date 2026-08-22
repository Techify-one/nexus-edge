import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    cloudflare({ configPath: "../workers/core/wrangler.jsonc" }),
  ],
  build: {
    target: "es2022",
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks: (id) => {
          if (
            id.includes("node_modules/react") ||
            id.includes("node_modules/react-dom") ||
            id.includes("node_modules/react-router")
          )
            return "react";
          if (id.includes("node_modules/@tanstack/react-query")) return "query";
          if (
            id.includes("node_modules/react-hook-form") ||
            id.includes("node_modules/zod")
          )
            return "forms";
          return undefined;
        },
      },
    },
  },
});
