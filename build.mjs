// Builds bundle.js, the single file SillyTavern loads (manifest.json → "js").
// The sources stay in index.js and src/; after any change to them run:
//
//     node build.mjs            write bundle.js
//     node build.mjs --check    fail if bundle.js is not what the sources produce
//
// It needs webpack. SillyTavern already has it, so the script looks in this folder's node_modules first,
// then in the SillyTavern the extension is installed into, then in the folder given by --st <path>.
import { createRequire } from 'node:module';
import { existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const check = args.includes('--check');
const stArg = args.includes('--st') ? args[args.indexOf('--st') + 1] : null;

function findWebpack() {
    const bases = [root, path.resolve(root, '../../../../..'), stArg].filter(Boolean);
    for (const base of bases) {
        if (!existsSync(path.join(base, 'node_modules', 'webpack'))) continue;
        return createRequire(path.join(base, 'package.json'))('webpack');
    }
    throw new Error('webpack not found. Run "npm i webpack" here or pass --st <SillyTavern folder>.');
}

const webpack = findWebpack();
const outDir = check ? mkdtempSync(path.join(tmpdir(), 'slaylorebooks-')) : root;

const config = {
    mode: 'production',
    context: root,
    entry: './index.js',
    devtool: false,
    experiments: { outputModule: true },
    output: { path: outDir, filename: 'bundle.js', module: true, library: { type: 'module' }, chunkFormat: 'module' },
    // Everything outside this folder is SillyTavern's own code: leave it as an import, with the path seen from bundle.js.
    externalsType: 'module',
    externals: [({ context, request }, cb) => {
        // Counted in "../" steps, not resolved on disk: the sources need not sit inside a SillyTavern folder.
        const ups = (request.match(/^(?:\.\.\/)+/) || [''])[0].length / 3;
        const depth = path.relative(root, context).split(path.sep).filter(Boolean).length;
        if (ups > depth) return cb(null, 'module ' + '../'.repeat(ups - depth) + request.slice(ups * 3));
        cb();
    }],
    // new URL('./ui.css', import.meta.url) must stay as written
    // Every file is an ES module, whatever a package.json up the tree says: the result must not depend on where the folder lies.
    module: { rules: [{ test: /\.js$/, type: 'javascript/esm' }], parser: { javascript: { url: false, importMeta: false } } },
    performance: { hints: false },
};

webpack(config, (err, stats) => {
    if (err || stats.hasErrors()) {
        console.error(err || stats.toString({ colors: false, errors: true, all: false }));
        process.exit(1);
    }
    const built = readFileSync(path.join(outDir, 'bundle.js'), 'utf8');
    if (!check) { console.log(`bundle.js written, ${Math.round(built.length / 1024)} KB`); return; }
    const current = existsSync(path.join(root, 'bundle.js')) ? readFileSync(path.join(root, 'bundle.js'), 'utf8') : '';
    rmSync(outDir, { recursive: true, force: true });
    if (built.replace(/\r\n/g, '\n') !== current.replace(/\r\n/g, '\n')) { console.error('bundle.js is stale: run "node build.mjs"'); process.exit(1); }
    console.log('bundle.js is up to date');
});
