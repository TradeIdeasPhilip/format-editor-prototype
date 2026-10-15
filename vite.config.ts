import { defineConfig } from "vite";

// Help for this config file:
// https://vitejs.dev/config/#config-intellisense

export default defineConfig({
  build: {
    target: "esnext",
  },
  // Relative paths so the build works from GitHub Pages or any subdirectory.
  base: "./",
});
