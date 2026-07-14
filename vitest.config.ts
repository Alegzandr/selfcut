import { defineConfig } from 'vitest/config';

// Unit tests target pure logic (model math, parsing, presets) — no DOM needed.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
