import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
    proxy: {
      '/api': 'http://localhost:3001',
      '/uploads': 'http://localhost:3001',
      '/socket.io': {
        target: 'http://localhost:3001',
        ws: true,
        // Глушим шумные [vite] ws proxy socket error: ECONNABORTED — это
        // нормальное поведение при HMR-reconnect Socket.IO upgrade,
        // которое vite-proxy выводит на каждый штатный disconnect.
        configure: (proxy) => {
          proxy.on('error', (err) => {
            if (err && (err.code === 'ECONNABORTED' || err.code === 'ECONNRESET')) return;
            // оставляем все остальные ошибки видимыми
            console.warn('[socket.io proxy]', err.message);
          });
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./test/setup.js'],
    include: ['test/**/*.test.{js,jsx}'],
    css: false,
  },
});
