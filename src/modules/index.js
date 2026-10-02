// Mitgelieferte Module. Weitere Module können im Ordner `modules/` (Projektwurzel)
// abgelegt werden und werden beim Start automatisch geladen.
import blog from './blog/index.js';
import media from './media/index.js';
import menus from './menus/index.js';
import newsletter from './newsletter/index.js';
import pages from './pages/index.js';

export const builtinModules = [media, pages, blog, menus, newsletter];
