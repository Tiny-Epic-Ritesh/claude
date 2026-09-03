import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: '/ai-crm/',
  build: {
    rollupOptions: {
      output: {
        /**
         * React and the router in their own chunk.
         *
         * They change when we upgrade them, which is rarely, while app code
         * changes on every deploy. Split apart, a returning user re-downloads
         * only what actually changed instead of the whole product.
         *
         * Matched by path rather than by package name. The list form named
         * 'react-dom', but the app imports 'react-dom/client', which is a
         * different module id and never matched -- so react-dom, by some way
         * the largest of the three, sat in the app chunk and was re-downloaded
         * on every deploy while a 34 kB "vendor" chunk did the caching. It also
         * needs `scheduler`, which react-dom depends on and which would
         * otherwise be stranded in the app chunk on its own.
         */
        manualChunks(id) {
          if (/[\/]node_modules[\/](react|react-dom|react-router|react-router-dom|scheduler)[\/]/.test(id)) {
            return 'vendor';
          }
          return undefined;
        },
      },
    },
  },
  server: {
    port: 5200,
    // One origin for all three surfaces, so no CORS handling in the app.
    proxy: {
      '/api': 'http://localhost:4100',
      // Unauthenticated surfaces, each on its own prefix so it is obvious from
      // a URL alone whether a request carries a session.
      '/public': 'http://localhost:4100',
      '/dkyc-api': { target: 'http://localhost:4100', rewrite: (p) => p.replace(/^\/dkyc-api/, '/dkyc') },
    },
  },
});
