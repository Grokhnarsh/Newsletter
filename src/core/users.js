import { badRequest, conflict, notFound, unauthorized } from '../lib/errors.js';
import { hashPassword, randomToken, sha256, verifyPassword } from '../lib/security.js';
import { addHours, now } from '../lib/time.js';

const PUBLIC_FIELDS = 'id, email, name, role, created_at, last_login_at';
export const API_KEY_PREFIX = 'nlk_';

export class UserService {
  constructor(db, config) {
    this.db = db;
    this.config = config;
  }

  count() {
    return this.db.get('SELECT COUNT(*) AS n FROM users').n;
  }

  list() {
    return this.db.all(`SELECT ${PUBLIC_FIELDS} FROM users ORDER BY email`);
  }

  find(id) {
    const user = this.db.get(`SELECT ${PUBLIC_FIELDS} FROM users WHERE id = ?`, id);
    if (!user) throw notFound('Benutzer nicht gefunden');
    return user;
  }

  create({ email, name = '', password, role = 'editor' }) {
    if (this.db.get('SELECT id FROM users WHERE email = ?', email)) throw conflict('E-Mail-Adresse wird bereits verwendet');
    const { lastInsertRowid } = this.db.run(
      'INSERT INTO users (email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)',
      email,
      name,
      hashPassword(password),
      role,
      now(),
    );
    return this.find(lastInsertRowid);
  }

  update(id, { email, name, password, role }) {
    const user = this.find(id);
    if (role && role !== 'admin' && user.role === 'admin' && this.adminCount() <= 1) {
      throw badRequest('Der letzte Administrator kann nicht herabgestuft werden');
    }
    if (email && email !== user.email && this.db.get('SELECT id FROM users WHERE email = ? AND id != ?', email, id)) {
      throw conflict('E-Mail-Adresse wird bereits verwendet');
    }
    this.db.run(
      'UPDATE users SET email = COALESCE(?, email), name = COALESCE(?, name), role = COALESCE(?, role) WHERE id = ?',
      email ?? null,
      name ?? null,
      role ?? null,
      id,
    );
    if (password) {
      this.db.run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(password), id);
    }
    return this.find(id);
  }

  remove(id, currentUserId) {
    const user = this.find(id);
    if (id === currentUserId) throw badRequest('Du kannst dich nicht selbst löschen');
    if (user.role === 'admin' && this.adminCount() <= 1) throw badRequest('Der letzte Administrator kann nicht gelöscht werden');
    this.db.transaction(() => {
      // API-Schlüssel gehören zum Konto und dürfen es nicht überleben.
      this.db.run('DELETE FROM api_keys WHERE created_by = ?', id);
      this.db.run('DELETE FROM users WHERE id = ?', id);
    });
  }

  adminCount() {
    return this.db.get("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").n;
  }

  verifyCredentials(email, password) {
    const row = this.db.get('SELECT * FROM users WHERE email = ?', email);
    // Auch bei unbekannter Adresse einen Hash berechnen, um Timing-Unterschiede zu vermeiden.
    const ok = verifyPassword(password, row?.password_hash ?? 'scrypt$AAAAAAAAAAAAAAAAAAAAAA==$' + 'A'.repeat(86) + '==');
    if (!row || !ok) throw unauthorized('E-Mail oder Passwort falsch');
    return row;
  }

  checkPassword(id, password) {
    const row = this.db.get('SELECT password_hash FROM users WHERE id = ?', id);
    if (!row || !verifyPassword(password, row.password_hash)) throw badRequest('Aktuelles Passwort ist falsch');
  }

  changeOwnPassword(id, currentPassword, newPassword) {
    this.checkPassword(id, currentPassword);
    this.db.run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(newPassword), id);
  }

  // ---- Sitzungen ----

  createSession(userId) {
    const token = randomToken(32);
    const t = now();
    this.db.run(
      'INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
      sha256(token),
      userId,
      t,
      addHours(t, this.config.sessionTtlHours),
    );
    this.db.run('UPDATE users SET last_login_at = ? WHERE id = ?', t, userId);
    this.db.run('DELETE FROM sessions WHERE expires_at < ?', t);
    return token;
  }

  userForSession(token) {
    return this.db.get(
      `SELECT u.id, u.email, u.name, u.role FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ?`,
      sha256(token),
      now(),
    );
  }

  destroySession(token) {
    this.db.run('DELETE FROM sessions WHERE token_hash = ?', sha256(token));
  }

  destroyUserSessions(userId, exceptToken) {
    this.db.run('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?', userId, exceptToken ? sha256(exceptToken) : '');
  }

  // ---- API-Schlüssel ----

  listApiKeys() {
    return this.db.all(
      `SELECT k.id, k.name, k.prefix, k.created_at, k.last_used_at, u.email AS created_by_email
       FROM api_keys k LEFT JOIN users u ON u.id = k.created_by ORDER BY k.id DESC`,
    );
  }

  createApiKey(name, userId) {
    const key = API_KEY_PREFIX + randomToken(30);
    const { lastInsertRowid } = this.db.run(
      'INSERT INTO api_keys (name, prefix, key_hash, created_by, created_at) VALUES (?, ?, ?, ?, ?)',
      name,
      key.slice(0, 10),
      sha256(key),
      userId,
      now(),
    );
    return { id: lastInsertRowid, name, prefix: key.slice(0, 10), key };
  }

  deleteApiKey(id) {
    const { changes } = this.db.run('DELETE FROM api_keys WHERE id = ?', id);
    if (!changes) throw notFound('API-Schlüssel nicht gefunden');
  }

  apiKeyLookup(key) {
    const row = this.db.get('SELECT id, name FROM api_keys WHERE key_hash = ?', sha256(key));
    if (row) this.db.run('UPDATE api_keys SET last_used_at = ? WHERE id = ?', now(), row.id);
    return row;
  }
}
