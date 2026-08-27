import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import {
  CONTENT_JS_PATH,
  CONTENT_JSON_PATH,
  PROJECT_ROOT,
  readCanonicalContent,
  revisionForContent,
  serializeContentJs,
  validateReferencedAssets,
  writeCanonicalContent
} from './content-core.mjs';

async function importLegacyJavaScript() {
  const source = await readFile(CONTENT_JS_PATH, 'utf8');
  const sandbox = Object.create(null);
  sandbox.window = Object.create(null);
  vm.runInNewContext(source, sandbox, {
    filename: CONTENT_JS_PATH,
    timeout: 1_000,
    contextCodeGeneration: { strings: false, wasm: false }
  });
  if (!sandbox.window.EML_DATA || typeof sandbox.window.EML_DATA !== 'object') {
    throw new Error('The legacy data/site-data.js file did not define window.EML_DATA.');
  }
  return JSON.parse(JSON.stringify(sandbox.window.EML_DATA));
}

async function initializeFromLegacy() {
  try {
    await readFile(CONTENT_JSON_PATH, 'utf8');
    throw new Error('data/site-data.json already exists; initialization was not performed.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const legacy = await importLegacyJavaScript();
  const result = await writeCanonicalContent(legacy);
  process.stdout.write(`Initialized data/site-data.json (${result.revision}).\n`);
}

async function fixGeneratedFiles() {
  let source;
  try {
    source = JSON.parse(await readFile(CONTENT_JSON_PATH, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot repair generated files because data/site-data.json is invalid: ${error.message}`);
  }
  const result = await writeCanonicalContent(source);
  process.stdout.write(`Canonical content files updated (${result.revision}).\n`);
}

async function check() {
  const result = await readCanonicalContent({ verifyGenerated: true });
  const assetErrors = await validateReferencedAssets(result.content);
  if (assetErrors.length) throw new Error(`Referenced asset validation failed:\n- ${assetErrors.join('\n- ')}`);

  const generated = await readFile(CONTENT_JS_PATH, 'utf8');
  if (generated.replaceAll('\r\n', '\n') !== serializeContentJs(result.content)) {
    throw new Error('Generated JavaScript content is not deterministic.');
  }
  if (result.revision !== revisionForContent(result.content)) throw new Error('Content revision is not deterministic.');

  const relativeJson = CONTENT_JSON_PATH.slice(PROJECT_ROOT.length + 1).replaceAll('\\', '/');
  process.stdout.write(`Content check passed: ${relativeJson} (${result.revision}, ${assetErrors.length} missing assets).\n`);
}

async function main() {
  const argumentsList = process.argv.slice(2);
  const known = new Set(['--initialize', '--fix', '--help']);
  const unknown = argumentsList.filter((argument) => !known.has(argument));
  if (unknown.length) throw new Error(`Unknown option: ${unknown.join(', ')}`);
  if (argumentsList.includes('--help')) {
    process.stdout.write('Usage: node tools/check-content.mjs [--initialize | --fix]\n');
    return;
  }
  if (argumentsList.includes('--initialize') && argumentsList.includes('--fix')) {
    throw new Error('Use only one of --initialize or --fix.');
  }
  if (argumentsList.includes('--initialize')) await initializeFromLegacy();
  if (argumentsList.includes('--fix')) await fixGeneratedFiles();
  await check();
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
