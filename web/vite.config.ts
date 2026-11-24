import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// В разработке запросы /api проксируются на backend (npm run start:dev в папке backend)
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': { target: process.env.API_URL ?? 'http://localhost:3000', changeOrigin: true } },
  },
});
