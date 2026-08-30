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
         */
        manualChunks: {
          vendor: ['react', 'react-dom', 'react-router-dom'],
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
