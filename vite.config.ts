import { defineConfig } from 'vite';

// Mobile-first build (CLAUDE.md §3): relative base so the bundle can be dropped on
// any static host / itch.io zip, es2020 output so 2020-era iOS Safari still parses it,
// and sourcemaps kept because profiling a minified mobile bundle is otherwise hopeless.
export default defineConfig({
  base: './',
  server: {
    host: true, // LAN access — the only way to honour "test on a real phone" (§13)
    port: 5173,
  },
  preview: {
    host: true,
    port: 4173,
  },
  build: {
    target: 'es2020',
    sourcemap: true,
    assetsInlineLimit: 4096,
    chunkSizeWarningLimit: 900,
    reportCompressedSize: true,
  },
});
