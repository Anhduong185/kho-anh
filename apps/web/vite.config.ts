import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const releasesDir = path.resolve(__dirname, '../../releases');

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'serve-releases-downloads',
      configureServer(server) {
        server.middlewares.use('/downloads', (req, res, next) => {
          const fileName = path.basename((req.url ?? '').split('?')[0] || '');
          if (!fileName || !fileName.endsWith('.apk')) return next();
          const fullPath = path.join(releasesDir, fileName);
          if (!fs.existsSync(fullPath)) return next();
          res.setHeader('Content-Type', 'application/vnd.android.package-archive');
          res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
          res.setHeader('Content-Length', fs.statSync(fullPath).size);
          fs.createReadStream(fullPath).pipe(res);
        });
      }
    }
  ],
  server: {
    host: true,
    port: 5173,
    watch: {
      ignored: ['**/android/**', '**/ios/**']
    },
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3001',
        changeOrigin: true
      },
      '/health': {
        target: 'http://127.0.0.1:3001',
        changeOrigin: true
      }
    }
  }
});
