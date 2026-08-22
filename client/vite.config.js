import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
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
