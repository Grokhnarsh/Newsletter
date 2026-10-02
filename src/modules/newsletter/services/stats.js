export class StatsService {
  constructor(db, { campaigns }) {
    this.db = db;
    this.campaigns = campaigns;
  }

  overview({ days = 30 } = {}) {
    const statusCounts = Object.fromEntries(
      ['pending', 'active', 'unsubscribed', 'bounced', 'complained'].map((s) => [s, 0]),
    );
    for (const row of this.db.all('SELECT status, COUNT(*) AS n FROM subscribers GROUP BY status')) statusCounts[row.status] = row.n;

    const since = new Date(Date.now() - (days - 1) * 86400_000);
    since.setUTCHours(0, 0, 0, 0);
    const sinceIso = since.toISOString();

    const rows = this.db.all(
      `SELECT substr(created_at, 1, 10) AS day, type, COUNT(*) AS n FROM events
       WHERE type IN ('subscribed', 'unsubscribed', 'bounced', 'complained') AND created_at >= ?
       GROUP BY day, type`,
      sinceIso,
    );
    const byDay = new Map();
    for (let i = 0; i < days; i++) {
      const day = new Date(since.getTime() + i * 86400_000).toISOString().slice(0, 10);
      byDay.set(day, { day, subscribed: 0, unsubscribed: 0 });
    }
    for (const r of rows) {
      const entry = byDay.get(r.day);
      if (!entry) continue;
      if (r.type === 'subscribed') entry.subscribed += r.n;
      else entry.unsubscribed += r.n;
    }
    const growth = [...byDay.values()];

    const recent = this.campaigns.list().filter((c) => ['sent', 'sending'].includes(c.status)).slice(0, 5);
    const sentCampaigns = this.campaigns.list({ status: 'sent' }).slice(0, 10).filter((c) => c.sent_count > 0);
    const avg = (key) =>
      sentCampaigns.length ? Math.round((sentCampaigns.reduce((sum, c) => sum + c[key], 0) / sentCampaigns.length) * 10) / 10 : null;

    return {
      subscribers: {
        ...statusCounts,
        total: Object.values(statusCounts).reduce((a, b) => a + b, 0),
        new_in_period: growth.reduce((a, d) => a + d.subscribed, 0),
        lost_in_period: growth.reduce((a, d) => a + d.unsubscribed, 0),
      },
      lists: this.db.get('SELECT COUNT(*) AS n FROM lists').n,
      campaigns: {
        total: this.db.get('SELECT COUNT(*) AS n FROM campaigns').n,
        sent: this.db.get("SELECT COUNT(*) AS n FROM campaigns WHERE status = 'sent'").n,
        scheduled: this.db.get("SELECT COUNT(*) AS n FROM campaigns WHERE status = 'scheduled'").n,
        avg_open_rate: avg('open_rate'),
        avg_click_rate: avg('click_rate'),
      },
      queue: this.db.get(
        "SELECT COUNT(*) AS n FROM campaign_recipients r JOIN campaigns c ON c.id = r.campaign_id WHERE r.status = 'queued' AND c.status = 'sending'",
      ).n,
      growth,
      recent_campaigns: recent,
      period_days: days,
    };
  }
}
