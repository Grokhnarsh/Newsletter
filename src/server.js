import { createCms } from './app.js';
import { loadConfig } from './config.js';
import { openDatabase } from './db/index.js';
import { createMailer } from './lib/mailer.js';

const config = loadConfig();
const db = openDatabase(config.databasePath);
const mailer = createMailer(config.mail);
const { app, ctx } = await createCms({ db, config, mailer });

// Optional: erstes Administratorkonto aus Umgebungsvariablen anlegen
if (config.initialAdmin.email && config.initialAdmin.password && ctx.users.count() === 0) {
  const user = ctx.users.create({ email: config.initialAdmin.email.toLowerCase(), password: config.initialAdmin.password, role: 'admin', name: 'Administrator' });
  ctx.hooks.collect('system.setup', { user });
  console.log(`Administrator ${config.initialAdmin.email} angelegt.`);
}

if (ctx.users.count() === 0) {
  console.log(`Einrichtungscode für das erste Administratorkonto: ${ctx.setupToken}`);
}

const server = app.listen(config.port, config.host, () => {
  console.log(`CMS läuft auf ${config.baseUrl}`);
  console.log(`Admin-Oberfläche: ${config.baseUrl}/admin/`);
  console.log(`Module: ${ctx.modules.describe().map((m) => `${m.name}${m.enabled ? '' : ' (aus)'}`).join(', ')}`);
  console.log(`Mail-Transport: ${mailer.kind}${mailer.kind === 'file' ? ` (${config.mail.outboxDir})` : ''}`);
});

await ctx.modules.start(ctx);
ctx.backups.start();

async function shutdown(signal) {
  console.log(`${signal} empfangen – fahre herunter …`);
  ctx.backups.stop();
  await ctx.modules.stop(ctx);
  server.close(() => {
    mailer.close();
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
