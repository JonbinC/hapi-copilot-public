import {lstat, readFile, realpath} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const ENTRY = path.join('server', 'index.mjs');
const SHA_RE = /^[a-f0-9]{40}$/;

function requireTrustedStat(stat, label, {directory = false, uid = 0} = {}) {
  if (stat.uid !== uid || (directory ? !stat.isDirectory() : !stat.isFile())) {
    throw new Error(`untrusted ${label} owner or type`);
  }
  if ((stat.mode & 0o022) !== 0) throw new Error(`untrusted writable permissions on ${label}`);
}

async function realDir(p, label, uid) {
  const [st, resolved] = await Promise.all([lstat(p), realpath(p)]);
  requireTrustedStat(st, label, {directory: true, uid});
  if (resolved !== p) throw new Error(`unexpected symlink in ${label}`);
}

async function verifyParents(root, uid) {
  let parent = path.dirname(root);
  while (true) {
    await realDir(parent, 'release root ancestor', uid);
    if (parent === path.dirname(parent)) break;
    parent = path.dirname(parent);
  }
}

export async function resolveSelectedEntrypoint({
  root = ROOT, selector = path.join(root, 'current-release'),
  releases = path.join(root, 'releases'), uid = 0, checkParents = true,
} = {}) {
  if (checkParents) await verifyParents(root, uid);
  await realDir(root, 'release root', uid);
  await realDir(releases, 'releases directory', uid);
  const selectorStat = await lstat(selector);
  requireTrustedStat(selectorStat, 'release selector', {uid});
  if ((selectorStat.mode & 0o004) === 0) throw new Error('release selector must be readable by the service account');
  if (selectorStat.mode & 0o022) throw new Error('release selector must not be group/world writable');
  const selectorContents = await readFile(selector, 'utf8');
  const name = selectorContents.endsWith('\n') ? selectorContents.slice(0, -1) : selectorContents;
  if (!SHA_RE.test(name)) throw new Error('release selector must contain one lowercase 40-character commit SHA');

  const release = path.join(releases, name);
  const entrypoint = path.join(release, ENTRY);
  const serverDir = path.join(release, 'server');
  const [releaseStat, releaseReal, serverStat, serverReal, entryStat, entryReal] = await Promise.all([
    lstat(release), realpath(release), lstat(serverDir), realpath(serverDir), lstat(entrypoint), realpath(entrypoint),
  ]);
  requireTrustedStat(releaseStat, 'release directory', {directory: true, uid});
  if (releaseReal !== release) throw new Error('release directory must not be a symlink');
  requireTrustedStat(serverStat, 'release server directory', {directory: true, uid});
  if (serverReal !== serverDir) throw new Error('release server directory must not be a symlink');
  requireTrustedStat(entryStat, 'release entrypoint', {uid});
  if (entryReal !== entrypoint) throw new Error('release entrypoint must not be a symlink');
  return entrypoint;
}

export async function runBootstrap(options = {}) {
  const entrypoint = await resolveSelectedEntrypoint(options);
  process.argv[1] = entrypoint;
  await import(pathToFileURL(entrypoint).href);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  runBootstrap().catch(error => {
    process.stderr.write(`hapi-copilot bootstrap: ${error.message}\n`);
    process.exitCode = 1;
  });
}
