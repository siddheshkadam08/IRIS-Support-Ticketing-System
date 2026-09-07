import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

/**
 * The iframe application. Emitted to dist/app/ and loaded by the injected
 * iframe — never inline on the host page, so host CSS and JS cannot reach it
 * and it cannot reach them.
 */
export default defineConfig({
  root: fileURLToPath(new URL('./src/app', import.meta.url)),
  base: './',
  build: {
    outDir: fileURLToPath(new URL('./dist/app', import.meta.url)),
    emptyOutDir: true,
    target: 'es2020',
    rollupOptions: {
      output: {
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name].[ext]',
      },
    },
  },
});
