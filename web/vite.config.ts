import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/** In dev, serve the separate display bundle at /display (the Argus server does this in production). */
function displayRoute(): Plugin {
  return {
    name: 'argus-display-route',
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        if (req.url === '/display' || req.url?.startsWith('/display/')) req.url = '/display.html';
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), displayRoute()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: { '/v1': 'http://127.0.0.1:8080' },
  },
  build: {
    rollupOptions: {
      input: { main: 'index.html', display: 'display.html' },
    },
  },
});
