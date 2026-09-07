import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

/**
 * The drop-in loader — this is the file an integrating product includes.
 *
 * Built as a self-executing IIFE with no imports, no globals touched beyond
 * one namespaced window key, and kept small: it runs on every page load of
 * every integrating product, so bundle size is a feature, not a preference.
 */
export default defineConfig({
  build: {
    outDir: fileURLToPath(new URL('./dist', import.meta.url)),
    emptyOutDir: false,
    target: 'es2019',
    minify: 'esbuild',
    lib: {
      entry: fileURLToPath(new URL('./src/loader.ts', import.meta.url)),
      name: 'IrisSupportLoader',
      formats: ['iife'],
      fileName: () => 'widget.js',
    },
  },
});
