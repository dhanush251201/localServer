import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// `npm run dev:ui` for UI work: proxies the admin API to a running gateway.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5190,
    proxy: {
      '/_api': { target: 'http://localhost:8080', headers: { host: 'localserver.localhost' } },
    },
  },
});
