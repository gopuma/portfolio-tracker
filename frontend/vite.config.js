import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Fail instead of drifting to 5174: the backend only accepts browser requests from the
    // origins in CORS_ORIGINS (default http://localhost:5173).
    strictPort: true,
    proxy: {
      // 127.0.0.1, not localhost: the backend binds IPv4 loopback only, and localhost can
      // resolve to ::1 first.
      '/api': 'http://127.0.0.1:4000',
    },
  },
});
