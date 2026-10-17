import { defineConfig } from 'vite';

// The offline build (scripts/build-offline.mjs) inlines exactly one JS bundle,
// so the lazily imported scene must stay in the same chunk.
export default defineConfig({
  // Agent worktrees live under .claude/; their builds must not reload the dev page.
  server: { watch: { ignored: ['**/.claude/**', '**/dist/**'] } },
  build: {
    rolldownOptions: { output: { codeSplitting: false } },
  },
});
