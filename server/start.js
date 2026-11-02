import { createApp } from './app.js';
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '127.0.0.1';
const { server, notifications } = createApp({ password: process.env.OPENDOIST_PASSWORD, database: process.env.DATABASE_PATH || './data/opendoist.sqlite', publicUrl: process.env.PUBLIC_URL, secureCookie: process.env.COOKIE_SECURE === 'true' });
server.listen(port, host, () => { console.log(`OpenDoist: http://${host}:${port}`); notifications.start(); });
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, async () => { setTimeout(() => process.exit(1), 30000).unref(); await notifications.stop(); server.close(() => process.exit(0)); });
