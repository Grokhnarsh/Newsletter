// Alle Zeitstempel werden als ISO-8601-Strings in UTC gespeichert.
export const migrations = [
  {
    version: 1,
    sql: `
      CREATE TABLE users (
        id INTEGER PRIMARY KEY,
        email TEXT NOT NULL UNIQUE COLLATE NOCASE,
        name TEXT NOT NULL DEFAULT '',
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('admin', 'editor')),
        created_at TEXT NOT NULL,
        last_login_at TEXT
      );

      CREATE TABLE sessions (
        token_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE INDEX idx_sessions_user ON sessions(user_id);

      CREATE TABLE api_keys (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        prefix TEXT NOT NULL,
        key_hash TEXT NOT NULL UNIQUE,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        last_used_at TEXT
      );

      CREATE TABLE lists (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        is_public INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE subscribers (
        id INTEGER PRIMARY KEY,
        email TEXT NOT NULL UNIQUE COLLATE NOCASE,
        first_name TEXT NOT NULL DEFAULT '',
        last_name TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'unsubscribed', 'bounced', 'complained')),
        attributes TEXT NOT NULL DEFAULT '{}',
        token TEXT NOT NULL UNIQUE,
        source TEXT NOT NULL DEFAULT '',
        ip TEXT,
        consent_at TEXT,
        confirmed_at TEXT,
        confirmation_sent_at TEXT,
        unsubscribed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_subscribers_status ON subscribers(status);
      CREATE INDEX idx_subscribers_created ON subscribers(created_at);

      CREATE TABLE subscriber_lists (
        subscriber_id INTEGER NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
        list_id INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        PRIMARY KEY (subscriber_id, list_id)
      );
      CREATE INDEX idx_subscriber_lists_list ON subscriber_lists(list_id);

      CREATE TABLE templates (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        html TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE campaigns (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        subject TEXT NOT NULL DEFAULT '',
        preheader TEXT NOT NULL DEFAULT '',
        from_name TEXT NOT NULL DEFAULT '',
        from_email TEXT NOT NULL DEFAULT '',
        reply_to TEXT NOT NULL DEFAULT '',
        content_html TEXT NOT NULL DEFAULT '',
        content_text TEXT NOT NULL DEFAULT '',
        template_id INTEGER REFERENCES templates(id) ON DELETE SET NULL,
        status TEXT NOT NULL DEFAULT 'draft'
          CHECK (status IN ('draft', 'scheduled', 'sending', 'paused', 'sent', 'cancelled')),
        track_opens INTEGER NOT NULL DEFAULT 1,
        track_clicks INTEGER NOT NULL DEFAULT 1,
        archive INTEGER NOT NULL DEFAULT 0,
        scheduled_at TEXT,
        started_at TEXT,
        finished_at TEXT,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_campaigns_status ON campaigns(status);

      CREATE TABLE campaign_lists (
        campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
        list_id INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
        PRIMARY KEY (campaign_id, list_id)
      );

      CREATE TABLE campaign_recipients (
        id INTEGER PRIMARY KEY,
        campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
        subscriber_id INTEGER REFERENCES subscribers(id) ON DELETE SET NULL,
        token TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'failed', 'skipped')),
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT,
        error TEXT,
        message_id TEXT,
        sent_at TEXT,
        opened_at TEXT,
        open_count INTEGER NOT NULL DEFAULT 0,
        clicked_at TEXT,
        click_count INTEGER NOT NULL DEFAULT 0,
        UNIQUE (campaign_id, subscriber_id)
      );
      CREATE INDEX idx_recipients_queue ON campaign_recipients(status, campaign_id);

      CREATE TABLE links (
        id INTEGER PRIMARY KEY,
        campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
        url TEXT NOT NULL,
        UNIQUE (campaign_id, url)
      );

      CREATE TABLE link_clicks (
        id INTEGER PRIMARY KEY,
        link_id INTEGER NOT NULL REFERENCES links(id) ON DELETE CASCADE,
        recipient_id INTEGER REFERENCES campaign_recipients(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_link_clicks_link ON link_clicks(link_id);

      CREATE TABLE events (
        id INTEGER PRIMARY KEY,
        type TEXT NOT NULL,
        subscriber_id INTEGER REFERENCES subscribers(id) ON DELETE CASCADE,
        campaign_id INTEGER REFERENCES campaigns(id) ON DELETE CASCADE,
        data TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_events_type_created ON events(type, created_at);
      CREATE INDEX idx_events_subscriber ON events(subscriber_id);
      CREATE INDEX idx_events_campaign ON events(campaign_id, type);

      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `,
  },
];
