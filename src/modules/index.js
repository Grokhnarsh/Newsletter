// Mitgelieferte Module. Weitere Module können im Ordner `modules/` (Projektwurzel)
// abgelegt werden und werden beim Start automatisch geladen.
import blog from './blog/index.js';
import media from './media/index.js';
import menus from './menus/index.js';
import newsletter from './newsletter/index.js';
import pages from './pages/index.js';
import redirects from './redirects/index.js';

// Reihenfolge zählt für Fallback-Routen: erst Seiten, dann Weiterleitungen.
export const builtinModules = [media, pages, blog, menus, redirects, newsletter];
