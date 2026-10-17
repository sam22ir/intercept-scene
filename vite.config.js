import { defineConfig } from 'vite';

// The offline build (scripts/build-offline.mjs) inlines exactly one JS bundle,
// so the lazily imported scene must stay in the same chunk.
export default defineConfig({
  build: {
    rolldownOptions: { output: { codeSplitting: false } },
  },
});
