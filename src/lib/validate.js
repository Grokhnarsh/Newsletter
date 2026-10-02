import { badRequest } from './errors.js';

// Pragmatische Prüfung: ein @, keine Leerzeichen, Domain mit Punkt.
const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/;

/** Erlaubt nur http(s)-Adressen und Pfade auf der eigenen Website (kein javascript: o. Ä.). */
export const SAFE_URL = { pattern: /^(https?:\/\/[^\s]+|\/(?!\/)[^\s]*)$/i, patternMessage: 'Nur http(s)-Adressen oder Pfade wie /seite' };

export function isEmail(value) {
  return typeof value === 'string' && value.length <= 254 && EMAIL_RE.test(value);
}

export function normalizeEmail(value) {
  return String(value ?? '').trim().toLowerCase();
}

/**
 * Validiert ein Objekt anhand eines einfachen Schemas.
 * Schema-Einträge: { type: 'string'|'email'|'int'|'bool'|'enum'|'ids'|'object'|'date',
 *                   required, max, min, values, default, trim }
 * Bei `partial` werden nur vorhandene Felder geprüft (für Updates).
 */
export function validate(input, schema, { partial = false } = {}) {
  const data = input && typeof input === 'object' ? input : {};
  const out = {};
  const errors = {};

  for (const [key, rule] of Object.entries(schema)) {
    let value = data[key];
    const missing = value === undefined || value === null || (typeof value === 'string' && value.trim() === '' && rule.type !== 'string');
    if (missing) {
      if (partial && value === undefined) continue;
      if (rule.required) {
        errors[key] = 'Pflichtfeld';
        continue;
      }
      if (rule.default !== undefined) out[key] = typeof rule.default === 'function' ? rule.default() : rule.default;
      else if (!partial || value !== undefined) out[key] = rule.type === 'string' ? '' : null;
      continue;
    }

    switch (rule.type) {
      case 'string': {
        if (typeof value !== 'string' && typeof value !== 'number') {
          errors[key] = 'Muss ein Text sein';
          break;
        }
        value = String(value);
        if (rule.trim !== false) value = value.trim();
        if (rule.required && value === '') errors[key] = 'Pflichtfeld';
        else if (rule.max && value.length > rule.max) errors[key] = `Maximal ${rule.max} Zeichen`;
        else if (rule.min && value.length < rule.min) errors[key] = `Mindestens ${rule.min} Zeichen`;
        else if (rule.pattern && value !== '' && !rule.pattern.test(value)) errors[key] = rule.patternMessage || 'Ungültiges Format';
        else out[key] = value;
        break;
      }
      case 'email': {
        value = normalizeEmail(value);
        if (!isEmail(value)) errors[key] = 'Ungültige E-Mail-Adresse';
        else out[key] = value;
        break;
      }
      case 'int': {
        const n = Number(value);
        if (!Number.isInteger(n)) errors[key] = 'Muss eine ganze Zahl sein';
        else if (rule.min !== undefined && n < rule.min) errors[key] = `Mindestens ${rule.min}`;
        else if (rule.max !== undefined && n > rule.max) errors[key] = `Höchstens ${rule.max}`;
        else out[key] = n;
        break;
      }
      case 'bool':
        out[key] = value === true || value === 1 || ['1', 'true', 'on', 'yes'].includes(String(value).toLowerCase());
        break;
      case 'enum':
        if (!rule.values.includes(value)) errors[key] = `Erlaubt: ${rule.values.join(', ')}`;
        else out[key] = value;
        break;
      case 'ids': {
        const arr = Array.isArray(value) ? value : String(value).split(',');
        const ids = arr.map((v) => Number(v)).filter((v) => Number.isInteger(v) && v > 0);
        if (ids.length !== arr.filter((v) => String(v).trim() !== '').length) errors[key] = 'Ungültige IDs';
        else out[key] = [...new Set(ids)];
        break;
      }
      case 'object':
        if (typeof value !== 'object' || Array.isArray(value)) errors[key] = 'Muss ein Objekt sein';
        else out[key] = value;
        break;
      case 'date': {
        const d = new Date(value);
        if (Number.isNaN(d.getTime())) errors[key] = 'Ungültiges Datum';
        else out[key] = d.toISOString();
        break;
      }
      default:
        throw new Error(`Unbekannter Regeltyp ${rule.type}`);
    }
  }

  if (Object.keys(errors).length) throw badRequest('Validierung fehlgeschlagen', errors);
  return out;
}

export function parseId(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw badRequest('Ungültige ID');
  return id;
}

export function pagination(query, { defaultPerPage = 25, maxPerPage = 200 } = {}) {
  const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
  const perPage = Math.min(maxPerPage, Math.max(1, Number.parseInt(query.per_page, 10) || defaultPerPage));
  return { page, perPage, offset: (page - 1) * perPage };
}
