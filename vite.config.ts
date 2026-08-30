import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id === "\0commonjs-dynamic-modules") {
            return "commonjs-runtime";
          }

          if (!id.includes("node_modules")) {
            return undefined;
          }

          // CodeMirror and ProseMirror both depend on this tiny package. Keep
          // it neutral so Rollup does not make the lazy Markdown editor pull
          // in the complete legacy TipTap/ProseMirror chunk.
          if (id.includes("/w3c-keyname/")) {
            return "keyboard-keynames";
          }

          if (id.includes("/@tiptap/") || id.includes("/prosemirror-")) {
            return "editor";
          }

          if (id.includes("/firebase/storage/") || id.includes("/@firebase/storage/")) {
            return "firebase-storage";
          }

          if (id.includes("/firebase/") || id.includes("/@firebase/")) {
            return "firebase";
          }

          if (id.includes("/pdfjs-dist/") && !id.includes("?url")) {
            return "pdf-preview";
          }

          if (id.includes("/docx-preview/")) {
            return "docx-preview";
          }

          if (id.includes("/cfb/")) {
            return "hwp-parser";
          }

          if (id.includes("/fflate/")) {
            return "compression";
          }

          if (id.includes("/lucide-react/")) {
            return "icons";
          }

          if (/\/node_modules\/(?:react|react-dom|react-router|react-router-dom)\//u.test(id)) {
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
    exclude: [
      "tests/firestore.rules.test.ts",
      "tests/storage.rules.test.ts",
      "tests/secureShareApiEmulator.test.ts",
      "tests/e2e/**",
      "node_modules",
      "dist",
      "functions/lib"
    ]
  }
});
