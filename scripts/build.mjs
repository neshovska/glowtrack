// Build step: minify/obfuscate index.html for GitHub Pages deployment.
// Source of truth stays index.html at repo root; this writes dist/.
import { readFile, writeFile, mkdir, copyFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { minify as terserMinify } from 'terser';
import { minify as htmlMinify } from 'html-minifier-terser';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SRC_HTML = path.join(ROOT, 'index.html');
const DIST = path.join(ROOT, 'dist');

// Static assets served alongside index.html on GitHub Pages.
// Only these are copied through — dev-only files (Firebase CLI config,
// Python helper scripts, functions/ source, etc.) are intentionally excluded.
const PASSTHROUGH_FILES = [
  'CNAME',
  'apple-touch-icon.png',
  'icon-192.png',
  'icon-512.png',
  'home-care-evening.jpeg',
  'home-care-morning.jpeg',
  'laser-alexandrite.jpeg',
  'laser-diode.jpeg',
  'og-image.png',
  'profile-shadow-leaves.jpeg',
  'manifest.json',
  'sw.js',
];

// Top-level function/variable declarations must never be renamed or dropped:
// the app wires interactivity via bare-name onclick/onchange/... attributes
// in the static HTML, which terser cannot see (it only processes <script>
// contents). Safe by default: terser only mangles/drops top-level bindings
// when `toplevel: true` is explicitly set, which we never do here.
//
// This must be a factory, not a shared object: terser mutates nested
// compress/mangle option objects in place, so reusing the same nested
// object reference across multiple minify() calls (one per <script> block)
// silently corrupts later calls with state left over from earlier ones.
function terserOptions(isModule) {
  return {
    compress: { toplevel: false },
    mangle: { toplevel: false },
    format: { comments: false },
    module: isModule,
  };
}

async function minifyScripts(html) {
  const scriptTagRe = /<script([^>]*)>([\s\S]*?)<\/script>/g;
  let match;
  let out = '';
  let lastIndex = 0;
  let count = 0;

  while ((match = scriptTagRe.exec(html)) !== null) {
    const [full, attrs, content] = match;
    out += html.slice(lastIndex, match.index);
    lastIndex = match.index + full.length;

    const hasSrc = /\bsrc\s*=/.test(attrs);
    if (hasSrc || !content.trim()) {
      out += full;
      continue;
    }

    const isModule = /type\s*=\s*["']module["']/.test(attrs);
    const result = await terserMinify(content, terserOptions(isModule));

    if (result.error) {
      throw new Error(`terser failed on <script${attrs}>: ${result.error}`);
    }

    out += `<script${attrs}>${result.code || ''}</script>`;
    count++;
  }
  out += html.slice(lastIndex);
  console.log(`  minified ${count} inline <script> block(s)`);
  return out;
}

function extractOnHandlerNames(html) {
  const re = /\bon(?:click|change|input|submit|keydown|keyup|error|load)="([^"]*)"/g;
  const names = new Set();
  let m;
  while ((m = re.exec(html)) !== null) {
    const callRe = /([A-Za-z_$][\w$]*)\s*\(/g;
    let c;
    while ((c = callRe.exec(m[1])) !== null) names.add(c[1]);
  }
  return names;
}

function verifyHandlerNamesSurvive(originalHtml, builtHtml) {
  const names = extractOnHandlerNames(originalHtml);
  const missing = [];
  for (const name of names) {
    // window.js/globals keywords are irrelevant; skip obvious non-identifiers
    if (['if', 'return', 'new'].includes(name)) continue;
    if (!builtHtml.includes(name)) missing.push(name);
  }
  if (missing.length) {
    throw new Error(
      `Build verification failed: ${missing.length} function name(s) referenced by inline handlers are missing from the built output: ${missing.join(', ')}`
    );
  }
  console.log(`  verified ${names.size} inline-handler function name(s) survived minification`);
}

async function main() {
  console.log('Reading index.html...');
  const srcHtml = await readFile(SRC_HTML, 'utf8');

  console.log('Minifying inline <script> blocks with terser...');
  const withMinifiedJs = await minifyScripts(srcHtml);

  console.log('Minifying HTML with html-minifier-terser...');
  const minifiedHtml = await htmlMinify(withMinifiedJs, {
    collapseWhitespace: true,
    removeComments: true,
    removeRedundantAttributes: false,
    removeAttributeQuotes: false,
    minifyCSS: true,
    // JS is already minified above; re-minifying inline event-handler
    // attributes here is high-risk (they're parsed out of context) for
    // low benefit, so it stays off.
    minifyJS: false,
    conservativeCollapse: true,
    caseSensitive: true,
  });

  console.log('Verifying inline event-handler function names survived...');
  verifyHandlerNamesSurvive(srcHtml, minifiedHtml);

  if (existsSync(DIST)) await rm(DIST, { recursive: true });
  await mkdir(DIST, { recursive: true });
  await writeFile(path.join(DIST, 'index.html'), minifiedHtml, 'utf8');

  console.log('Copying static assets...');
  for (const file of PASSTHROUGH_FILES) {
    const src = path.join(ROOT, file);
    if (!existsSync(src)) {
      console.warn(`  WARNING: expected asset not found, skipping: ${file}`);
      continue;
    }
    await copyFile(src, path.join(DIST, file));
  }

  const origSize = Buffer.byteLength(srcHtml, 'utf8');
  const newSize = Buffer.byteLength(minifiedHtml, 'utf8');
  console.log(
    `Done. index.html: ${(origSize / 1024).toFixed(1)}KB -> ${(newSize / 1024).toFixed(1)}KB (${Math.round((1 - newSize / origSize) * 100)}% smaller)`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
