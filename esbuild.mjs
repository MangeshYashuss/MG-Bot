import * as esbuild from 'esbuild';
import * as fs from 'fs';

// Codicons (VS Code's icon font) ship inside dist/ because node_modules is excluded from the .vsix.
fs.mkdirSync('dist', { recursive: true });
for (const f of ['codicon.css', 'codicon.ttf']) fs.copyFileSync(`node_modules/@vscode/codicons/dist/${f}`, `dist/${f}`);

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

const common = { bundle: true, minify: production, sourcemap: !production, logLevel: 'info' };

const contexts = await Promise.all([
  // Extension host bundle (Node).
  esbuild.context({
    ...common,
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    external: ['vscode'],
  }),
  // Chat webview bundle (browser).
  esbuild.context({
    ...common,
    entryPoints: ['src/webview/media/main.ts'],
    outfile: 'dist/webview.js',
    platform: 'browser',
    format: 'iife',
    target: 'es2020',
  }),
]);

if (watch) {
  await Promise.all(contexts.map((c) => c.watch()));
} else {
  await Promise.all(contexts.map((c) => c.rebuild()));
  await Promise.all(contexts.map((c) => c.dispose()));
}
