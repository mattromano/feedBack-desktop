// Shared helper: transpile a main-process TypeScript module and load it with a
// controlled require(), so electron, sibling modules and the native addon can
// be replaced by stubs. Sibling './x' imports that are not stubbed are loaded
// the same way (transpiled from src). Nothing here starts electron or the
// native audio engine.
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const ROOT = path.join(__dirname, '..');

// stubs: { [requestId]: exports } where requestId is exactly what the module
// passes to require ('electron', './python', ...). resolveExtra(id) may return
// a value for ids not in stubs (return undefined to fall through); used for
// computed paths such as the native addon.
function loadTsStubbed(relPath, stubs = {}, resolveExtra = () => undefined, cache = new Map()) {
    const file = path.join(ROOT, relPath);
    if (cache.has(file)) return cache.get(file).exports;
    const source = fs.readFileSync(file, 'utf8');
    const compiled = ts.transpileModule(source, {
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2022,
            esModuleInterop: true,
        },
        fileName: file,
    }).outputText;
    const mod = { exports: {} };
    cache.set(file, mod);
    const dir = path.dirname(file);
    const req = (id) => {
        if (Object.prototype.hasOwnProperty.call(stubs, id)) return stubs[id];
        const extra = resolveExtra(id);
        if (extra !== undefined) return extra;
        if (id.startsWith('.')) {
            const tsFile = path.join(dir, id + '.ts');
            if (fs.existsSync(tsFile)) {
                return loadTsStubbed(path.relative(ROOT, tsFile), stubs, resolveExtra, cache);
            }
        }
        return require(id);
    };
    // eslint-disable-next-line no-new-func
    new Function('exports', 'require', 'module', '__filename', '__dirname', compiled)(
        mod.exports, req, mod, file, dir,
    );
    return mod.exports;
}

module.exports = { loadTsStubbed, ROOT };
