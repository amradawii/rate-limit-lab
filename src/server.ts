import { serve } from '@hono/node-server';
import { createApp } from './http/app.js';

const port = Number(process.env.PORT ?? 3000);

const server = serve({ fetch: createApp().fetch, port }, (info) => {
  console.log(`Listening on http://localhost:${info.port}`);
});

function shutdown(): void {
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
