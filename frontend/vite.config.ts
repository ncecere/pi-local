import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type ProxyOptions } from 'vite';

/**
 * In the desktop app the Go backend serves the built app (dist/) and /api
 * through the Wails asset server, same origin. In development this dev server
 * proxies /api to the headless Go server (`cmd/pi-local-server`, default
 * 127.0.0.1:5190), or to PI_LOCAL_API.
 *
 * The streams (/api/events, a thread's /events) are server-sent events: the
 * proxy must pass each event on as it arrives, never buffer or compress them.
 */
const api: ProxyOptions = {
  target: process.env.PI_LOCAL_API ?? 'http://127.0.0.1:5190',
  changeOrigin: false,
  configure(proxy) {
    proxy.on('proxyReq', (proxyReq, req) => {
      // An event stream must not be gzipped on the way (that buffers it).
      if (req.headers.accept?.includes('text/event-stream'))
        proxyReq.setHeader('Accept-Encoding', 'identity');
    });
    proxy.on('proxyRes', (proxyRes, _req, res) => {
      if (!proxyRes.headers['content-type']?.includes('text/event-stream')) return;
      proxyRes.headers['cache-control'] = 'no-cache, no-transform';
      proxyRes.headers['x-accel-buffering'] = 'no';
      res.on('pipe', () => res.flushHeaders?.());
    });
  },
};
const proxy = { '/api': api };

const port = Number(process.env.PORT ?? 5191);

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '~': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: { host: '127.0.0.1', port, strictPort: true, proxy },
  preview: { host: '127.0.0.1', port, proxy },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    manifest: true,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [{ name: 'initial-shared', tags: ['$initial'], minShareCount: 2 }],
        },
      },
    },
  },
});
