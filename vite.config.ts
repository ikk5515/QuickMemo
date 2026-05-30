import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) {
            return undefined;
          }

          if (id.includes("/@tiptap/") || id.includes("/prosemirror-")) {
            return "editor";
          }

          if (id.includes("/firebase/") || id.includes("/@firebase/")) {
            return "firebase";
          }

          if (id.includes("/pdfjs-dist/")) {
            return "pdf";
          }

          if (id.includes("/docx-preview/")) {
            return "docx-preview";
          }

          if (id.includes("/hwp.js/") || id.includes("/cfb/")) {
            return "office-preview";
          }

          if (id.includes("/fflate/")) {
            return "compression";
          }

          if (id.includes("/lucide-react/")) {
            return "icons";
          }

          if (id.includes("/react/") || id.includes("/react-dom/") || id.includes("/react-router/") || id.includes("/react-router-dom/")) {
            return "react";
          }

          return undefined;
        }
      }
    }
  },
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: "./src/test/setup.ts",
    exclude: ["tests/firestore.rules.test.ts", "node_modules", "dist", "functions/lib"]
  }
});
