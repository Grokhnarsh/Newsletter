export const DEFAULT_SETTINGS = {
  site_name: 'Mein Newsletter',
  sender_name: 'Newsletter',
  sender_email: 'newsletter@example.com',
  reply_to: '',
  company_address: '',
  privacy_url: '',
  double_opt_in: true,
  send_rate_per_minute: 60,
  default_template_id: null,
  confirm_subject: 'Bitte bestätige deine Anmeldung zu {{site_name}}',
  confirm_html:
    '<p>Hallo {{first_name | "zusammen"}},</p>\n<p>vielen Dank für dein Interesse an unserem Newsletter. Bitte bestätige deine Anmeldung mit einem Klick:</p>\n<p><a href="{{confirm_url}}" style="display:inline-block;background:#2563eb;color:#ffffff;padding:12px 20px;border-radius:6px;text-decoration:none;">Anmeldung bestätigen</a></p>\n<p>Falls du dich nicht angemeldet hast, kannst du diese E-Mail einfach ignorieren.</p>',
  welcome_enabled: false,
  welcome_subject: 'Willkommen bei {{site_name}}!',
  welcome_html:
    '<p>Hallo {{first_name | "zusammen"}},</p>\n<p>schön, dass du dabei bist! Ab sofort erhältst du unseren Newsletter.</p>',
};

const SETTING_RULES = {
  site_name: { type: 'string', max: 200 },
  sender_name: { type: 'string', max: 200 },
  sender_email: { type: 'email' },
  reply_to: { type: 'string', max: 254 },
  company_address: { type: 'string', max: 2000 },
  privacy_url: { type: 'string', max: 500 },
  double_opt_in: { type: 'bool' },
  send_rate_per_minute: { type: 'int', min: 1, max: 100000 },
  default_template_id: { type: 'int', min: 1 },
  confirm_subject: { type: 'string', max: 300 },
  confirm_html: { type: 'string', max: 100000, trim: false },
  welcome_enabled: { type: 'bool' },
  welcome_subject: { type: 'string', max: 300 },
  welcome_html: { type: 'string', max: 100000, trim: false },
};

export class SettingsService {
  constructor(db) {
    this.db = db;
  }

  get rules() {
    return SETTING_RULES;
  }

  all() {
    const stored = Object.fromEntries(this.db.all('SELECT key, value FROM settings').map((r) => [r.key, JSON.parse(r.value)]));
    return { ...DEFAULT_SETTINGS, ...stored };
  }

  get(key) {
    const row = this.db.get('SELECT value FROM settings WHERE key = ?', key);
    return row ? JSON.parse(row.value) : DEFAULT_SETTINGS[key];
  }

  update(values) {
    this.db.transaction(() => {
      for (const [key, value] of Object.entries(values)) {
        if (!(key in DEFAULT_SETTINGS)) continue;
        this.db.run(
          'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
          key,
          JSON.stringify(value),
        );
      }
    });
    return this.all();
  }

  fromAddress(override = {}) {
    const s = this.all();
    return {
      name: override.from_name || s.sender_name,
      address: override.from_email || s.sender_email,
    };
  }
}
