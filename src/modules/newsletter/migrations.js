// Tabellen des Newsletter-Moduls (IF NOT EXISTS: kompatibel mit Datenbanken
// aus der Zeit vor dem Modulsystem, in denen sie bereits existieren).
export const migrations = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS lists (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        is_public INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS subscribers (
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
      CREATE INDEX IF NOT EXISTS idx_subscribers_status ON subscribers(status);
      CREATE INDEX IF NOT EXISTS idx_subscribers_created ON subscribers(created_at);

      CREATE TABLE IF NOT EXISTS subscriber_lists (
        subscriber_id INTEGER NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
        list_id INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        PRIMARY KEY (subscriber_id, list_id)
      );
      CREATE INDEX IF NOT EXISTS idx_subscriber_lists_list ON subscriber_lists(list_id);

      CREATE TABLE IF NOT EXISTS templates (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        html TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS campaigns (
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
      CREATE INDEX IF NOT EXISTS idx_campaigns_status ON campaigns(status);

      CREATE TABLE IF NOT EXISTS campaign_lists (
        campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
        list_id INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
        PRIMARY KEY (campaign_id, list_id)
      );

      CREATE TABLE IF NOT EXISTS campaign_recipients (
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
      CREATE INDEX IF NOT EXISTS idx_recipients_queue ON campaign_recipients(status, campaign_id);

      CREATE TABLE IF NOT EXISTS links (
        id INTEGER PRIMARY KEY,
        campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
        url TEXT NOT NULL,
        UNIQUE (campaign_id, url)
      );

      CREATE TABLE IF NOT EXISTS link_clicks (
        id INTEGER PRIMARY KEY,
        link_id INTEGER NOT NULL REFERENCES links(id) ON DELETE CASCADE,
        recipient_id INTEGER REFERENCES campaign_recipients(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_link_clicks_link ON link_clicks(link_id);

      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY,
        type TEXT NOT NULL,
        subscriber_id INTEGER REFERENCES subscribers(id) ON DELETE CASCADE,
        campaign_id INTEGER REFERENCES campaigns(id) ON DELETE CASCADE,
        data TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_type_created ON events(type, created_at);
      CREATE INDEX IF NOT EXISTS idx_events_subscriber ON events(subscriber_id);
      CREATE INDEX IF NOT EXISTS idx_events_campaign ON events(campaign_id, type);
    `,
  },
];

// v2: Segmente, A/B-Test des Betreffs, Automationen, Tracking-Einwilligung.
// campaign_recipients wird neu aufgebaut (neuer Status „held“ für zurückgehaltene A/B-Empfänger).
migrations.push({
  version: 2,
  foreignKeysOff: true,
  sql: `
    CREATE TABLE segments (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      match TEXT NOT NULL DEFAULT 'all' CHECK (match IN ('all', 'any')),
      rules TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    ALTER TABLE campaigns ADD COLUMN segment_id INTEGER REFERENCES segments(id) ON DELETE SET NULL;
    ALTER TABLE campaigns ADD COLUMN subject_b TEXT NOT NULL DEFAULT '';
    ALTER TABLE campaigns ADD COLUMN ab_test_percent INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE campaigns ADD COLUMN ab_wait_hours INTEGER NOT NULL DEFAULT 4;
    ALTER TABLE campaigns ADD COLUMN ab_metric TEXT NOT NULL DEFAULT 'opens';
    ALTER TABLE campaigns ADD COLUMN ab_test_ends_at TEXT;
    ALTER TABLE campaigns ADD COLUMN ab_winner TEXT;

    CREATE TABLE campaign_recipients_new (
      id INTEGER PRIMARY KEY,
      campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      subscriber_id INTEGER REFERENCES subscribers(id) ON DELETE SET NULL,
      token TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'held', 'sent', 'failed', 'skipped')),
      variant TEXT CHECK (variant IN ('a', 'b')),
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
    INSERT INTO campaign_recipients_new (id, campaign_id, subscriber_id, token, status, attempts, next_attempt_at, error, message_id,
      sent_at, opened_at, open_count, clicked_at, click_count)
    SELECT id, campaign_id, subscriber_id, token, status, attempts, next_attempt_at, error, message_id,
      sent_at, opened_at, open_count, clicked_at, click_count FROM campaign_recipients;
    DROP TABLE campaign_recipients;
    ALTER TABLE campaign_recipients_new RENAME TO campaign_recipients;
    CREATE INDEX idx_recipients_queue ON campaign_recipients(status, campaign_id);

    ALTER TABLE subscribers ADD COLUMN tracking_consent INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE subscribers ADD COLUMN tracking_consent_at TEXT;

    CREATE TABLE automations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      trigger TEXT NOT NULL DEFAULT 'signup' CHECK (trigger IN ('signup')),
      list_id INTEGER REFERENCES lists(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'paused')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE automation_steps (
      id INTEGER PRIMARY KEY,
      automation_id INTEGER NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      delay_hours INTEGER NOT NULL DEFAULT 0,
      subject TEXT NOT NULL,
      preheader TEXT NOT NULL DEFAULT '',
      content_html TEXT NOT NULL DEFAULT '',
      template_id INTEGER REFERENCES templates(id) ON DELETE SET NULL
    );
    CREATE INDEX idx_automation_steps ON automation_steps(automation_id, position);
    CREATE TABLE automation_runs (
      id INTEGER PRIMARY KEY,
      automation_id INTEGER NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
      subscriber_id INTEGER NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
      next_step INTEGER NOT NULL DEFAULT 0,
      next_at TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'done', 'cancelled')),
      started_at TEXT NOT NULL,
      finished_at TEXT,
      UNIQUE (automation_id, subscriber_id)
    );
    CREATE INDEX idx_automation_runs_due ON automation_runs(status, next_at);
    CREATE TABLE automation_sends (
      id INTEGER PRIMARY KEY,
      run_id INTEGER NOT NULL REFERENCES automation_runs(id) ON DELETE CASCADE,
      step_id INTEGER REFERENCES automation_steps(id) ON DELETE SET NULL,
      status TEXT NOT NULL CHECK (status IN ('sent', 'failed')),
      error TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX idx_automation_sends_step ON automation_sends(step_id);
  `,
});
