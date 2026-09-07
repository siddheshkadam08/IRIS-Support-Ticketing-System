import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

/**
 * Built to admin-panel/dist and served by the GATEWAY at /admin.
 *
 * Same-origin with the API is deliberate: it lets the session live in an
 * httpOnly cookie the page's JavaScript cannot read, so an XSS here cannot
 * exfiltrate a session. A token in localStorage would not have that property.
 */
export default defineConfig({
  plugins: [react()],
  base: '/admin/',
  build: {
    outDir: fileURLToPath(new URL('./dist', import.meta.url)),
    emptyOutDir: true,
    target: 'es2020',
  },
  server: {
    // Dev-only convenience so `vite --port 3000` still reaches the API.
    proxy: { '/admin/auth': 'http://localhost:4000', '/admin/api': 'http://localhost:4000' },
  },
});
