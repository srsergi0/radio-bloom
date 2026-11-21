// @ts-check
import { defineConfig } from 'astro/config';
import react from '@astrojs/react';

// https://astro.build/config
export default defineConfig({
  integrations: [react()],
  i18n: {
    defaultLocale: 'es',
    locales: ['es', 'en'],
    routing: {
      prefixDefaultLocale: false
    }
  },
  vite: {
    server: {
      proxy: {
        '/api': 'http://127.0.0.1:9876',
        '/radiobloom': 'http://127.0.0.1:9876',
      }
    }
  }
});
