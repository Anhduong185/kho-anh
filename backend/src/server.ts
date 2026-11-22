import { buildApp } from './app.js';

async function start() {
  const { app, config } = await buildApp();
  try {
    await app.listen({ port: config.PORT, host: config.HOST });
    app.log.info(`Secure Media Backup API listening on http://${config.HOST}:${config.PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

void start();
