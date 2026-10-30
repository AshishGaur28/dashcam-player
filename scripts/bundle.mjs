#!/usr/bin/env node
// Turns the production build into ONE html file (script + styles inlined) that works when double-clicked:
// no server, no Node, no install. Run via `npm run bundle`.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const dist = new URL('../dist/', import.meta.url);
let html = readFileSync(new URL('index.html', dist), 'utf8');
const asset = (p) => readFileSync(new URL(p.replace(/^\//, ''), dist), 'utf8');

html = html
  .replace(/<script type="module" crossorigin src="([^"]+)"><\/script>/, '')
  .replace(/<link rel="stylesheet" crossorigin href="([^"]+)">/, (_, href) => `<style>${asset(href)}</style>`);
const entry = /<script type="module" crossorigin src="([^"]+)"><\/script>/.exec(readFileSync(new URL('index.html', dist), 'utf8'))?.[1];
if (!entry) throw new Error('Could not find the entry script in dist/index.html');
const code = asset(entry).replace(/<\/script/gi, '<\\/script');
html = html.replace('</body>', () => `<script type="module">${code}</script>\n</body>`);

mkdirSync(new URL('../release/', import.meta.url), { recursive: true });
const out = new URL('../release/DashcamPlayer.html', import.meta.url);
writeFileSync(out, html);
console.log(`release/DashcamPlayer.html  ${(html.length / 1024).toFixed(0)} KB (open it in Chrome, Edge or Safari)`);
