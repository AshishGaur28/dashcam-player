import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

// The version shown in the tool. A release build (GitHub Actions) passes the tag as APP_VERSION and, for ordinary pushes, the short commit as APP_BUILD;
// a local build uses package.json and no build label, so the committed release/DashcamPlayer.html does not change with every commit.
const version = (process.env.APP_VERSION ?? pkg.version).replace(/^v/, '');
const build = process.env.APP_BUILD ?? '';

export default defineConfig({
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(version), __APP_BUILD__: JSON.stringify(build) },
});
