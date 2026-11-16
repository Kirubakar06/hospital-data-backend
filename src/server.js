import { app } from './app.js';
import { env } from './config/env.js';
import { pool, verifyDatabase } from './config/db.js';

let server;

async function handleListenError(error) {
  if (error.code === 'EADDRINUSE') {
    try {
      const response = await fetch(`http://127.0.0.1:${env.port}/health`, {
        signal: AbortSignal.timeout(1500),
      });
      const health = await response.json();
      if (response.ok && health.success === true && health.data?.status === 'ok') {
        console.log(`CarePoint API is already running on port ${env.port}; no second instance was started.`);
        process.exitCode = 0;
        await pool.end();
        return;
      }
      console.error(`Port ${env.port} is occupied, but the service did not return a CarePoint health response.`);
    } catch (probeError) {
      console.error(`Port ${env.port} is occupied and its service could not be verified: ${probeError.message}`);
    }
    console.error(`Stop the existing service or configure PORT to use an available port.`);
  } else {
    console.error('Failed to start CarePoint API.', error.message);
  }
  process.exitCode = 1;
  await pool.end();
}

try {
  await verifyDatabase();
  server = app.listen(env.port, () => console.log(`CarePoint API listening on port ${env.port}`));
  server.once('error', (error) => {
    handleListenError(error).catch((handlerError) => {
      console.error('Failed to clean up after the API startup error.', handlerError.message);
      process.exitCode = 1;
    });
  });
} catch (error) {
  console.error('Unable to connect to MySQL. Check the database service and backend environment configuration.', error.message);
  process.exitCode = 1;
}

async function shutdown(signal) {
  console.log(`${signal} received; closing server and database pool.`);
  if (server) await new Promise((resolve) => server.close(resolve));
  await pool.end();
}

process.on('SIGINT', () => shutdown('SIGINT').finally(() => process.exit(0)));
process.on('SIGTERM', () => shutdown('SIGTERM').finally(() => process.exit(0)));
