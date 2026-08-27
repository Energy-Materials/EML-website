import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, stat, utimes } from 'node:fs/promises';
import path from 'node:path';
import { PROJECT_ROOT, readCanonicalContent, validateReferencedAssets } from './content-core.mjs';

const DIST_ROOT = path.join(PROJECT_ROOT, 'dist');
const REQUIRED_PUBLIC_ENTRIES = [
  'index.html',
  'styles.css',
  'app.js',
  'admin.html',
  'admin.css',
  'admin.js',
  'local-content-store.js',
  'data-validation.js',
  'data/site-data.js',
  'assets'
];
const OPTIONAL_PUBLIC_ENTRIES = ['_headers', '_redirects', '_routes.json'];
const FORBIDDEN_OUTPUT_NAMES = new Set([
  'admin-local.cmd',
  'package.json',
  'package-lock.json',
  'supabase-config.js',
  'cloud-data.js',
  'SUPABASE_SETUP.md'
]);
const FORBIDDEN_PUBLIC_EXTENSIONS = new Set([
  '.bak', '.cer', '.crt', '.db', '.der', '.jks', '.key', '.keystore', '.p12', '.pem', '.pfx', '.sql', '.sqlite'
]);
const FIXED_TIME = new Date('2000-01-01T00:00:00.000Z');

function assertSafePublicPath(relative) {
  const portable = relative.replaceAll('\\', '/');
  const segments = portable.split('/');
  const basename = segments.at(-1);
  const lowercase = basename.toLowerCase();
  if (segments.some((segment) => segment.startsWith('.'))
    || lowercase === 'credentials.json'
    || lowercase.startsWith('.env')
    || lowercase.startsWith('.dev.vars')
    || lowercase.includes('service-account')
    || FORBIDDEN_PUBLIC_EXTENSIONS.has(path.extname(lowercase))) {
    throw new Error(`Potentially private file is not allowed in the public build: ${portable}`);
  }
}

async function exists(targetPath) {
  try {
    await stat(targetPath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function listTree(root, relative = '') {
  const directory = path.join(root, relative);
  const entries = await readdir(directory, { withFileTypes: true });
  const output = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, 'en'))) {
    const entryRelative = path.join(relative, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Symbolic links are not allowed in the public build: ${entryRelative}`);
    if (entry.isDirectory()) output.push(...await listTree(root, entryRelative));
    if (entry.isFile()) output.push(entryRelative);
  }
  return output;
}

async function normalizeOutputMetadata(root) {
  const files = await listTree(root);
  for (const relative of files) await utimes(path.join(root, relative), FIXED_TIME, FIXED_TIME);
  return files;
}

async function createManifest(files) {
  const rows = [];
  for (const relative of files) {
    const portablePath = relative.replaceAll('\\', '/');
    const contents = await readFile(path.join(DIST_ROOT, relative));
    rows.push(`${createHash('sha256').update(contents).digest('hex')}  ${portablePath}`);
  }
  return `${rows.join('\n')}\n`;
}

async function verifyOutput(files) {
  for (const relative of files) {
    assertSafePublicPath(relative);
    const portable = relative.replaceAll('\\', '/');
    const basename = path.basename(relative);
    if (FORBIDDEN_OUTPUT_NAMES.has(basename) || portable.startsWith('tools/') || portable.startsWith('supabase/')) {
      throw new Error(`Private/local-only file leaked into dist: ${portable}`);
    }
  }
  const html = await readFile(path.join(DIST_ROOT, 'index.html'), 'utf8');
  for (const forbiddenReference of ['supabase-config.js', 'cloud-data.js']) {
    if (html.includes(forbiddenReference)) {
      throw new Error(`index.html still references local/private runtime file ${forbiddenReference}.`);
    }
  }
}

async function build() {
  const canonical = await readCanonicalContent({ verifyGenerated: true });
  const assetErrors = await validateReferencedAssets(canonical.content);
  if (assetErrors.length) throw new Error(`Build stopped because assets are missing:\n- ${assetErrors.join('\n- ')}`);

  for (const entry of REQUIRED_PUBLIC_ENTRIES) {
    if (!await exists(path.join(PROJECT_ROOT, entry))) throw new Error(`Required public entry is missing: ${entry}`);
  }

  const sourceAssets = await listTree(PROJECT_ROOT, 'assets');
  sourceAssets.forEach(assertSafePublicPath);

  await rm(DIST_ROOT, { recursive: true, force: true });
  await mkdir(DIST_ROOT, { recursive: true });

  for (const entry of REQUIRED_PUBLIC_ENTRIES) {
    await cp(path.join(PROJECT_ROOT, entry), path.join(DIST_ROOT, entry), {
      recursive: true,
      force: true,
      errorOnExist: false,
      dereference: false,
      preserveTimestamps: false
    });
  }
  for (const entry of OPTIONAL_PUBLIC_ENTRIES) {
    if (await exists(path.join(PROJECT_ROOT, entry))) {
      await cp(path.join(PROJECT_ROOT, entry), path.join(DIST_ROOT, entry), { force: true });
    }
  }

  let files = await normalizeOutputMetadata(DIST_ROOT);
  await verifyOutput(files);
  const manifest = await createManifest(files);
  const buildHash = createHash('sha256').update(manifest, 'utf8').digest('hex');
  process.stdout.write(`Deterministic public build created in dist/ (${files.length} files, build ${buildHash.slice(0, 12)}, ${canonical.revision}).\n`);
}

build().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
