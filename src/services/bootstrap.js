/** Legt Standarddaten an: eine öffentliche Liste und die Standardvorlage. */
export function seedDefaults({ lists, templates, settings }) {
  if (lists.list().length === 0) lists.create({ name: 'Newsletter', description: 'Allgemeiner Newsletter', is_public: true });
  const template = templates.seedDefault();
  if (template) settings.update({ default_template_id: template.id });
}
