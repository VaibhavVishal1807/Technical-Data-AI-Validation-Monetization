// Vite = the dev server and bundler for the React app.
// The proxy forwards /api and /ws to the Node backend, so the browser talks to
// one origin (localhost:5173) and we need no CORS configuration.
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig(({ mode }) => {
  // Read API_PORT from backend/.env too, so the port is set in one place.
  const backendDir = fileURLToPath(new URL('../backend', import.meta.url));
  const backendEnv = loadEnv(mode, backendDir, '');
  const apiPort = process.env.API_PORT || backendEnv.API_PORT || 4000;
  const apiTarget = `http://127.0.0.1:${apiPort}`;

  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      // "@/components/ui/card" means "src/components/ui/card" (shadcn/ui convention).
      alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    },
    build: {
      rolldownOptions: {
        output: {
          // React itself changes rarely, so it gets its own long-cached file.
          codeSplitting: {
            groups: [{ name: 'react', test: /node_modules[\\/](react|react-dom|react-router|react-router-dom|scheduler)[\\/]/ }],
          },
        },
      },
    },
    server: {
      port: 5173,
      proxy: {
        '/api': apiTarget,
        '/ws': { target: apiTarget.replace('http', 'ws'), ws: true },
      },
    },
  };
});
