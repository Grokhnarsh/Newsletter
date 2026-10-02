import { createApp, createServices } from './app.js';
import { loadConfig } from './config.js';
import { openDatabase } from './db/index.js';
import { createMailer } from './lib/mailer.js';
import { seedDefaults } from './services/bootstrap.js';

const config = loadConfig();
const db = openDatabase(config.databasePath);
const mailer = createMailer(config.mail);
const services = createServices({ db, config, mailer });

// Optional: erstes Administratorkonto aus Umgebungsvariablen anlegen
if (config.initialAdmin.email && config.initialAdmin.password && services.users.count() === 0) {
  services.users.create({ email: config.initialAdmin.email.toLowerCase(), password: config.initialAdmin.password, role: 'admin', name: 'Administrator' });
  seedDefaults(services);
  console.log(`Administrator ${config.initialAdmin.email} angelegt.`);
}

const app = createApp(services);
const server = app.listen(config.port, config.host, () => {
  console.log(`Newsletter-Server läuft auf ${config.baseUrl}`);
  console.log(`Admin-Oberfläche: ${config.baseUrl}/admin/`);
  console.log(`Mail-Transport: ${mailer.kind}${mailer.kind === 'file' ? ` (${config.mail.outboxDir})` : ''}`);
});

if (config.worker.enabled) services.delivery.start();

function shutdown(signal) {
  console.log(`${signal} empfangen – fahre herunter …`);
  services.delivery.stop();
  server.close(() => {
    mailer.close();
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
