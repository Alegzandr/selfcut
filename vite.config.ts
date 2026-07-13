import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Base path = nom du repo GitHub pour le déploiement sur GitHub Pages.
// Changez BASE_PATH (ou définissez la variable d'env VITE_BASE) si le repo est renommé.
const BASE_PATH = process.env.VITE_BASE ?? '/cutbay/';

export default defineConfig({
  base: BASE_PATH,
  plugins: [react(), tailwindcss()],
  worker: {
    format: 'es',
  },
  build: {
    target: 'es2022',
  },
});
