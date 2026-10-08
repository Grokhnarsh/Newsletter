import { badRequest, conflict, notFound, unauthorized } from '../lib/errors.js';
import { hashPassword, randomToken, sha256, verifyPassword } from '../lib/security.js';
import { addHours, addMinutes, now } from '../lib/time.js';
import { generateSecret, verifyTotp } from './totp.js';

const PUBLIC_FIELDS = 'id, email, name, role, totp_enabled, created_at, last_login_at';
export const ROLES = ['admin', 'editor', 'author'];
const RESET_TTL_MINUTES = 60;
const CHALLENGE_TTL_MINUTES = 5;
const MAX_CHALLENGE_ATTEMPTS = 5;

const shape = (u) => u && { ...u, totp_enabled: Boolean(u.totp_enabled) };
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
    return this.db.all(`SELECT ${PUBLIC_FIELDS} FROM users ORDER BY email`).map(shape);
  }

  find(id) {
    const user = this.db.get(`SELECT ${PUBLIC_FIELDS} FROM users WHERE id = ?`, id);
    if (!user) throw notFound('Benutzer nicht gefunden');
    return shape(user);
  }

  findByEmail(email) {
    return shape(this.db.get(`SELECT ${PUBLIC_FIELDS} FROM users WHERE email = ?`, email));
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

  // ---- Passwort zurücksetzen ----

  /** Erzeugt einen einmaligen Reset-Token (60 Minuten gültig); ältere Tokens verfallen. */
  createPasswordReset(userId) {
    const token = randomToken(32);
    const t = now();
    this.db.transaction(() => {
      this.db.run('DELETE FROM password_resets WHERE user_id = ? OR expires_at < ?', userId, t);
      this.db.run(
        'INSERT INTO password_resets (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
        sha256(token),
        userId,
        t,
        addMinutes(t, RESET_TTL_MINUTES),
      );
    });
    return token;
  }

  /** Setzt das Passwort per Reset-Token und beendet alle Sitzungen. */
  resetPassword(token, newPassword) {
    const row = this.db.get('SELECT * FROM password_resets WHERE token_hash = ?', sha256(String(token)));
    if (!row || row.used_at || row.expires_at < now()) throw badRequest('Der Link ist ungültig oder abgelaufen. Bitte fordere einen neuen an.');
    return this.db.transaction(() => {
      this.db.run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(newPassword), row.user_id);
      this.db.run('DELETE FROM password_resets WHERE user_id = ?', row.user_id);
      this.db.run('DELETE FROM sessions WHERE user_id = ?', row.user_id);
      return this.find(row.user_id);
    });
  }

  // ---- Zwei-Faktor-Anmeldung (TOTP) ----

  /** Neues, noch inaktives Geheimnis; wird erst mit einem gültigen Code aktiviert. */
  startTotpSetup(id) {
    const secret = generateSecret();
    this.db.run('UPDATE users SET totp_secret = ?, totp_enabled = 0, totp_last_counter = 0 WHERE id = ?', secret, id);
    return secret;
  }

  /** Aktiviert 2FA und liefert einmalig 10 Wiederherstellungscodes. */
  enableTotp(id, code) {
    const row = this.db.get('SELECT totp_secret, totp_enabled FROM users WHERE id = ?', id);
    if (!row?.totp_secret) throw badRequest('Bitte die Einrichtung zuerst starten');
    if (row.totp_enabled) throw badRequest('Zwei-Faktor-Anmeldung ist bereits aktiv');
    const counter = verifyTotp(row.totp_secret, code);
    if (counter === null) throw badRequest('Der Code ist ungültig. Bitte die Uhrzeit des Geräts prüfen.');
    const codes = Array.from({ length: 10 }, () => randomToken(6).replace(/[-_]/g, 'x').slice(0, 8).toLowerCase());
    this.db.run(
      'UPDATE users SET totp_enabled = 1, totp_last_counter = ?, recovery_codes = ? WHERE id = ?',
      counter,
      JSON.stringify(codes.map((c) => sha256(c))),
      id,
    );
    return codes;
  }

  disableTotp(id) {
    this.db.run("UPDATE users SET totp_secret = NULL, totp_enabled = 0, totp_last_counter = 0, recovery_codes = '[]' WHERE id = ?", id);
  }

  /** Prüft Authenticator-Code oder Wiederherstellungscode (wird dabei verbraucht). */
  verifySecondFactor(id, code) {
    const row = this.db.get('SELECT totp_secret, totp_last_counter, recovery_codes FROM users WHERE id = ? AND totp_enabled = 1', id);
    if (!row) return false;
    const counter = verifyTotp(row.totp_secret, code, { lastCounter: row.totp_last_counter });
    if (counter !== null) {
      this.db.run('UPDATE users SET totp_last_counter = ? WHERE id = ?', counter, id);
      return true;
    }
    const hash = sha256(String(code ?? '').trim().toLowerCase());
    const codes = JSON.parse(row.recovery_codes);
    if (!codes.includes(hash)) return false;
    this.db.run('UPDATE users SET recovery_codes = ? WHERE id = ?', JSON.stringify(codes.filter((c) => c !== hash)), id);
    return true;
  }

  recoveryCodesLeft(id) {
    return JSON.parse(this.db.get('SELECT recovery_codes FROM users WHERE id = ?', id)?.recovery_codes || '[]').length;
  }

  // ---- Anmelde-Challenge (zweiter Schritt nach dem Passwort) ----

  createChallenge(userId) {
    const token = randomToken(24);
    const t = now();
    this.db.run('DELETE FROM login_challenges WHERE expires_at < ?', t);
    this.db.run('INSERT INTO login_challenges (token_hash, user_id, expires_at) VALUES (?, ?, ?)', sha256(token), userId, addMinutes(t, CHALLENGE_TTL_MINUTES));
    return token;
  }

  /** Liefert die Benutzer-ID zur Challenge und zählt den Versuch. */
  useChallenge(token) {
    const hash = sha256(String(token ?? ''));
    const row = this.db.get('SELECT * FROM login_challenges WHERE token_hash = ?', hash);
    if (!row || row.expires_at < now() || row.attempts >= MAX_CHALLENGE_ATTEMPTS) {
      throw unauthorized('Die Anmeldung ist abgelaufen. Bitte erneut mit Passwort anmelden.');
    }
    this.db.run('UPDATE login_challenges SET attempts = attempts + 1 WHERE token_hash = ?', hash);
    return { userId: row.user_id, finish: () => this.db.run('DELETE FROM login_challenges WHERE token_hash = ?', hash) };
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
      `SELECT u.id, u.email, u.name, u.role, u.totp_enabled FROM sessions s JOIN users u ON u.id = s.user_id
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
