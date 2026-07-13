// Copies dist/index.html to dist/404.html so GitHub Pages serves the SPA on any path.
import { copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
copyFileSync(join(dist, 'index.html'), join(dist, '404.html'));
console.log('SPA fallback: dist/404.html created');
