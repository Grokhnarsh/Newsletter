// Admin-Oberfläche des Newsletter-Moduls
import { automationEditorView, automationsView } from './automations.js';
import { campaignEditorView, campaignReportView, campaignsView } from './campaigns.js';
import { newsletterWidget } from './dashboard.js';
import { listsView } from './lists.js';
import { segmentEditorView, segmentsView } from './segments.js';
import { emailsSettingsTab, newsletterSettingsTab } from './settings.js';
import { subscriberDetailView, subscribersView } from './subscribers.js';
import { templateEditorView, templatesView } from './templates.js';

export default function register(cms) {
  const group = 'Newsletter';
  cms.nav({ href: '#/campaigns', label: 'Kampagnen', icon: 'campaigns', group, order: 10 });
  cms.nav({ href: '#/subscribers', label: 'Abonnenten', icon: 'subscribers', group, order: 20 });
  cms.nav({ href: '#/lists', label: 'Listen', icon: 'lists', group, order: 30 });
  cms.nav({ href: '#/segments', label: 'Segmente', icon: 'segments', group, order: 35 });
  cms.nav({ href: '#/automations', label: 'Automationen', icon: 'automations', group, order: 15 });
  cms.nav({ href: '#/templates', label: 'Vorlagen', icon: 'templates', group, order: 40 });

  cms.route(/^\/subscribers$/, subscribersView);
  cms.route(/^\/subscribers\/(\d+)$/, subscriberDetailView);
  cms.route(/^\/lists$/, listsView);
  cms.route(/^\/campaigns$/, campaignsView);
  cms.route(/^\/campaigns\/new$/, (el) => campaignEditorView(el, null));
  cms.route(/^\/campaigns\/(\d+)$/, campaignEditorView);
  cms.route(/^\/campaigns\/(\d+)\/report$/, campaignReportView);
  cms.route(/^\/segments$/, segmentsView);
  cms.route(/^\/segments\/(new|\d+)$/, segmentEditorView);
  cms.route(/^\/automations$/, automationsView);
  cms.route(/^\/automations\/(new|\d+)$/, automationEditorView);
  cms.route(/^\/templates$/, templatesView);
  cms.route(/^\/templates\/(new|\d+)$/, templateEditorView);

  cms.widget({ id: 'newsletter', order: 50, render: newsletterWidget });
  cms.settingsTab({ id: 'newsletter', label: 'Newsletter', order: 40, render: newsletterSettingsTab });
  cms.settingsTab({ id: 'emails', label: 'System-E-Mails', order: 45, render: emailsSettingsTab });
}
