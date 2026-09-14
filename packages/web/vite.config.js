import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // In dev the UI runs on Vite and the API on the Node server; in production the
    // Node server serves this build directly, so the same relative paths work in both.
    proxy: { '/api': 'http://localhost:4000', '/sdk.js': 'http://localhost:4000' },
  },
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false },
});
