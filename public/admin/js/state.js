import { get, session } from './api.js';

/** Gemeinsamer Zustand der Admin-Oberfläche. */
export const ctx = {
  get user() {
    return session.user;
  },
  get isAdmin() {
    return session.user?.role === 'admin';
  },
  /** Autoren: nur eigene Entwürfe, Veröffentlichung über den Freigabe-Workflow. */
  get isAuthor() {
    return session.user?.role === 'author';
  },
  settings: null,
  lists: null,
  /** Listen werden in vielen Ansichten gebraucht – kurz zwischenspeichern. */
  async getLists(force = false) {
    if (!this.lists || force) this.lists = await get('/lists');
    return this.lists;
  },
  invalidateLists() {
    this.lists = null;
  },
  async getSettings(force = false) {
    if (!this.settings || force) this.settings = await get('/settings');
    return this.settings;
  },
};

export function navigate(hash) {
  if (location.hash === hash) window.dispatchEvent(new HashChangeEvent('hashchange'));
  else location.hash = hash;
}
