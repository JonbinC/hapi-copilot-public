import {constants} from 'node:fs';
import {
  chmod, copyFile, lstat, open, readFile, realpath, rename, readdir,
} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {resolveSelectedEntrypoint} from './bridge-bootstrap.mjs';

export const PRODUCTION_ROOT = '/opt/hapi-copilot';
export const SERVICE = 'hapi-console-tunnel.service';
export const STARTUP_GRACE_MS = 45_000;
export const STABILITY_MS = 15_000;
const SHA_RE = /^[a-f0-9]{40}$/;
const HASH_RE = /^[a-f0-9]{64}$/;
const BOOTSTRAP_SOURCE = fileURLToPath(new URL('./bridge-bootstrap.mjs', import.meta.url));

function assertSha(sha) {
  if (typeof sha !== 'string' || !SHA_RE.test(sha)) throw new Error('release must be a lowercase 40-character commit SHA');
}

async function readSelector(selector) {
  const contents = await readFile(selector, 'utf8');
  const sha = contents.endsWith('\n') ? contents.slice(0, -1) : contents;
  assertSha(sha);
  return sha;
}

function trusted(stat, label, {directory = false, uid = 0} = {}) {
  if (stat.uid !== uid || (directory ? !stat.isDirectory() : !stat.isFile())) throw new Error('untrusted ' + label + ' owner or type');
  if (stat.mode & 0o022) throw new Error('untrusted writable permissions on ' + label);
}

function trustedSelector(stat, label, uid) {
  trusted(stat, label, {uid});
  if ((stat.mode & 0o004) === 0) throw new Error(label + ' must be readable by the service account');
}

async function verifyParents(root, uid) {
  let parent = path.dirname(root);
  while (true) {
    const st = await lstat(parent);
    trusted(st, 'release root ancestor', {directory: true, uid});
    if (await realpath(parent) !== parent) throw new Error('release root ancestor must not be a symlink');
    if (parent === path.dirname(parent)) break;
    parent = path.dirname(parent);
  }
}

export async function validateRelease(root, sha, uid = 0, {checkParents = true} = {}) {
  assertSha(sha);
  if (checkParents) await verifyParents(root, uid);
  const releases = path.join(root, 'releases');
  const release = path.join(releases, sha);
  const serverDir = path.join(release, 'server');
  const entry = path.join(serverDir, 'index.mjs');
  const [rootStat, releasesStat, releaseStat, releaseReal, serverStat, serverReal, entryStat, entryReal] = await Promise.all([
    lstat(root), lstat(releases), lstat(release), realpath(release),
    lstat(serverDir), realpath(serverDir), lstat(entry), realpath(entry),
  ]);
  trusted(rootStat, 'release root', {directory: true, uid});
  trusted(releasesStat, 'releases directory', {directory: true, uid});
  trusted(releaseStat, 'release directory', {directory: true, uid});
  if (releaseReal !== release) throw new Error('release directory must be a direct child, not a symlink');
  trusted(serverStat, 'release server directory', {directory: true, uid});
  if (serverReal !== serverDir) throw new Error('release server directory must not be a symlink');
  trusted(entryStat, 'server/index.mjs', {uid});
  if (entryReal !== entry) throw new Error('server/index.mjs must not be a symlink');
  return entry;
}

function parseCgroup(text) {
  return text.split('\n').map(line => line.split(':').at(-1)).find(p => p && p.startsWith('/system.slice/'));
}

function procStartTime(statText) {
  const close = statText.lastIndexOf(')');
  if (close < 0) return null;
  const fields = statText.slice(close + 1).trim().split(/\s+/);
  return fields[19] || null; // /proc stat field 22, after pid and comm.
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function inspectService({root = PRODUCTION_ROOT, proc = '/proc', runner = spawnSync} = {}) {
  const activeResult = runner('systemctl', ['is-active', SERVICE], {encoding: 'utf8', timeout: 5000});
  const cgroupResult = runner('systemctl', ['show', SERVICE, '--property=ControlGroup', '--value'], {encoding: 'utf8', timeout: 5000});
  const cgroup = cgroupResult.stdout?.trim() || '';
  const cgroupVerified = cgroupResult.status === 0 && cgroup.startsWith('/system.slice/');
  const active = activeResult.status === 0 && (activeResult.stdout || '').trim() === 'active';
  if (!cgroupVerified) return {active: false, cgroup: '', cgroupVerified: false, tunnel: [], bridge: []};
  const tunnel = [], bridge = [];
  const names = (await readdir(proc)).filter(n => /^\d+$/.test(n));
  const bridgePath = new RegExp('^' + escapeRegExp(path.join(root, 'releases')) + '/[a-f0-9]{40}/server/index\\.mjs$');
  for (const pidText of names) {
    try {
      const dir = path.join(proc, pidText);
      const [cg, cmd, stat] = await Promise.all([
        readFile(path.join(dir, 'cgroup'), 'utf8'),
        readFile(path.join(dir, 'cmdline')),
        readFile(path.join(dir, 'stat'), 'utf8'),
      ]);
      const actual = parseCgroup(cg);
      if (actual !== cgroup && !actual?.startsWith(cgroup + '/')) continue;
      const args = cmd.toString().split('\0').filter(Boolean);
      const startTime = procStartTime(stat);
      if (!startTime) continue;
      const identity = {pid: Number(pidText), startTime};
      if (args.some(a => /(?:^|\/)tunnel-client$/.test(a))) tunnel.push(identity);
      if (args[0] && /(?:^|\/)node(?:\.exe)?$/.test(args[0]) && args.some(a => bridgePath.test(a))) bridge.push(identity);
    } catch { /* A process can exit while /proc is being read. */ }
  }
  tunnel.sort((a, b) => a.pid - b.pid);
  bridge.sort((a, b) => a.pid - b.pid);
  return {active, cgroup, cgroupVerified: true, tunnel, bridge};
}

function processSignature(state) {
  return JSON.stringify({
    cgroup: state.cgroup,
    tunnel: state.tunnel.map(p => [p.pid, p.startTime]),
    bridge: state.bridge.map(p => [p.pid, p.startTime]),
  });
}

function healthy(state) {
  return state.active && state.cgroupVerified !== false && state.tunnel.length === 1 && state.bridge.length === 1 &&
    state.tunnel[0].pid > 0 && state.bridge[0].pid > 0 && state.tunnel[0].startTime && state.bridge[0].startTime;
}

async function stableService({inspect, sleep, now, startupGraceMs, stabilityMs, mustChangeBridgePid}) {
  const deadline = now() + startupGraceMs;
  let baseline = null;
  let initial = null;
  while (now() <= deadline) {
    const state = await inspect();
    if (healthy(state)) {
      if (mustChangeBridgePid !== undefined && state.bridge[0].pid === mustChangeBridgePid) {
        throw new Error('Bridge PID did not change across the restart; cutover is unverified');
      }
      baseline = processSignature(state);
      initial = state;
      break;
    }
    await sleep(Math.min(1000, Math.max(1, deadline - now())));
  }
  if (!baseline) throw new Error('service did not become active with exactly one identified tunnel-client and Bridge Node within startup grace');
  const stableUntil = now() + stabilityMs;
  while (now() < stableUntil) {
    await sleep(Math.min(1000, stableUntil - now()));
    const state = await inspect();
    if (!healthy(state) || processSignature(state) !== baseline) {
      throw new Error('service unit state or process identities changed during the stability gate');
    }
  }
  return initial;
}

async function atomicSelector(root, sha, uid = 0) {
  assertSha(sha);
  const selector = path.join(root, 'current-release');
  const temp = path.join(root, '.current-release.' + process.pid + '.' + Date.now() + '.tmp');
  const h = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o644);
  try {
    await h.writeFile(sha + '\n');
    await h.sync();
  } finally { await h.close(); }
  await chmod(temp, 0o644);
  trustedSelector(await lstat(temp), 'temporary selector', uid);
  await rename(temp, selector);
  const dir = await open(root, constants.O_RDONLY);
  try { await dir.sync(); } finally { await dir.close(); }
}

async function syncPath(filePath) {
  const h = await open(filePath, constants.O_RDONLY);
  try { await h.sync(); } finally { await h.close(); }
}

export class ReleaseOperationError extends Error {
  constructor(message, status, details = {}) {
    super(message);
    this.name = 'ReleaseOperationError';
    this.status = status;
    this.details = details;
  }
}

async function rollbackAndVerify({root, uid, old, beforeBridgePid, restart, inspect, sleep, now, startupGraceMs, stabilityMs, checkParents}) {
  try {
    await atomicSelector(root, old, uid);
    if (await readSelector(path.join(root, 'current-release')) !== old) throw new Error('restored selector did not read back as the prior SHA');
    await validateRelease(root, old, uid, {checkParents});
    await restart(SERVICE);
    const restored = await stableService({inspect, sleep, now, startupGraceMs, stabilityMs, mustChangeBridgePid: beforeBridgePid});
    if (await readSelector(path.join(root, 'current-release')) !== old) throw new Error('selector changed during rollback verification');
    return {status: 'rolled_back_verified', restoredRelease: old, bridgePid: restored.bridge[0].pid};
  } catch (error) {
    throw new ReleaseOperationError('rollback_failed: selector restoration or restored-service health verification failed: ' + error.message,
      'rollback_failed', {restoredRelease: old});
  }
}

export async function activateRelease({
  root = PRODUCTION_ROOT, sha, apply = false, uid = 0,
  restart, inspect,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  now = () => Date.now(), startupGraceMs = STARTUP_GRACE_MS, stabilityMs = STABILITY_MS,
  checkParents = true,
} = {}) {
  const target = await validateRelease(root, sha, uid, {checkParents});
  const selector = path.join(root, 'current-release');
  let old = null;
  try {
    trustedSelector(await lstat(selector), 'current selector', uid);
    old = await readSelector(selector);
    await validateRelease(root, old, uid, {checkParents});
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const result = {mode: apply ? 'apply' : 'dry-run', service: SERVICE, from: old, to: sha, target};
  if (!apply || old === sha) return result;
  if (!old) throw new Error('activation requires a valid existing selector so automatic rollback is possible');
  if (typeof restart !== 'function' || typeof inspect !== 'function') {
    throw new Error('activation apply requires guarded service restart and active/PID health inspection');
  }
  const before = await inspect();
  if (!healthy(before)) throw new Error('refusing activation because the existing service and Bridge PID identity are not healthy and observable');
  const beforeBridgePid = before.bridge[0].pid;
  await atomicSelector(root, sha, uid);
  try {
    await restart(SERVICE);
    const activated = await stableService({inspect, sleep, now, startupGraceMs, stabilityMs, mustChangeBridgePid: beforeBridgePid});
    if (await readSelector(selector) !== sha) throw new Error('selected release changed during activation verification');
    return {...result, switched_verified: true, bridgePid: activated.bridge[0].pid};
  } catch (error) {
    const rollback = await rollbackAndVerify({root, uid, old, beforeBridgePid, restart, inspect, sleep, now, startupGraceMs, stabilityMs, checkParents});
    throw new ReleaseOperationError('activation failed; ' + rollback.status + ': ' + error.message,
      rollback.status, {...rollback, attemptedRelease: sha});
  }
}

function validateRegisteredEntrypoint(value) {
  if (typeof value !== 'string' || !/^releases\/[a-f0-9]{40}\/server\/index\.mjs$/.test(value)) {
    throw new Error('registered entrypoint must be releases/<40-hex-sha>/server/index.mjs');
  }
  return value;
}

export async function installBootstrap({
  root = PRODUCTION_ROOT, registeredEntrypoint, initialRelease, originalBackup, originalBackupSha256,
  apply = false, uid = 0, source = BOOTSTRAP_SOURCE, restart,
  inspect, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  now = () => Date.now(), startupGraceMs = STARTUP_GRACE_MS, stabilityMs = STABILITY_MS,
  checkParents = true,
} = {}) {
  const relEntry = validateRegisteredEntrypoint(registeredEntrypoint);
  assertSha(initialRelease);
  if (!originalBackup || !path.isAbsolute(originalBackup)) throw new Error('original backup must be an explicit absolute path');
  if (typeof originalBackupSha256 !== 'string' || !HASH_RE.test(originalBackupSha256)) throw new Error('original backup SHA256 must be explicitly supplied');
  await validateRelease(root, initialRelease, uid, {checkParents});
  const target = path.join(root, relEntry);
  const entrySha = relEntry.split('/')[1];
  const existing = await lstat(target);
  trusted(existing, 'registered entrypoint', {uid});
  const originalMode = existing.mode & 0o777;
  const currentEntrypoint = await readFile(target, 'utf8');
  if (currentEntrypoint.includes('hapi-copilot bootstrap')) {
    const currentSha = await readSelector(path.join(root, 'current-release'));
    await validateRelease(root, currentSha, uid, {checkParents});
    return {mode: apply ? 'apply' : 'dry-run', target, selector: currentSha, alreadyInstalled: true};
  }
  if (!currentEntrypoint.includes(initialRelease)) {
    throw new Error('registered entrypoint is not a forwarder to the supplied initial release; migration stopped');
  }
  const backupsDir = path.join(root, 'release-backups');
  trusted(await lstat(backupsDir), 'release-backups directory', {directory: true, uid});
  const originalReal = await realpath(originalBackup);
  if (!originalReal.startsWith(backupsDir + path.sep)) throw new Error('original backup must be inside release-backups');
  trusted(await lstat(originalBackup), 'operator-designated original backup', {uid});
  const originalHash = createHash('sha256').update(await readFile(originalBackup)).digest('hex');
  if (originalHash !== originalBackupSha256) throw new Error('operator-designated original backup SHA256 mismatch');
  const backupName = path.basename(target) + '.pre-bootstrap-' + new Date().toISOString().replace(/[:.]/g, '-');
  const backup = path.join(backupsDir, backupName);
  if (!apply) return {mode: 'dry-run', target, registeredRelease: entrySha, initialRelease, backup, source};
  if (typeof restart !== 'function' || typeof inspect !== 'function') {
    throw new Error('bootstrap installation apply requires guarded service restart and active/PID health verification');
  }
  trusted(await lstat(source), 'bootstrap source', {uid});
  const selector = path.join(root, 'current-release');
  let prior = null;
  try {
    trustedSelector(await lstat(selector), 'current selector', uid);
    prior = await readSelector(selector);
    if (prior !== initialRelease) throw new Error('existing selector does not match the supplied initial release; migration stopped');
    await validateRelease(root, prior, uid, {checkParents});
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const before = await inspect();
  if (!healthy(before)) throw new Error('refusing bootstrap migration because the existing service and Bridge PID identity are not healthy and observable');
  const beforeBridgePid = before.bridge[0].pid;
  if (!prior) await atomicSelector(root, initialRelease, uid); // Selector is durable before the loader can become active.
  const selectedBeforeInstall = await readSelector(selector);
  trustedSelector(await lstat(selector), 'current selector', uid);
  if (selectedBeforeInstall !== initialRelease) throw new Error('initialized selector did not verify against the supplied initial release');
  await validateRelease(root, selectedBeforeInstall, uid, {checkParents});
  await copyFile(target, backup, constants.COPYFILE_EXCL);
  await chmod(backup, 0o600);
  const savedHash = createHash('sha256').update(await readFile(backup)).digest('hex');
  const currentHash = createHash('sha256').update(await readFile(target)).digest('hex');
  if (savedHash !== currentHash) throw new Error('saved registered entrypoint backup did not verify; live entrypoint was not replaced');
  await syncPath(backup);
  await syncPath(backupsDir);
  const temp = target + '.bootstrap-' + process.pid + '.tmp';
  await copyFile(source, temp, constants.COPYFILE_EXCL);
  await chmod(temp, originalMode);
  await syncPath(temp);
  await rename(temp, target);
  await syncPath(path.dirname(target));
  try {
    await restart(SERVICE);
    const activated = await stableService({inspect, sleep, now, startupGraceMs, stabilityMs, mustChangeBridgePid: beforeBridgePid});
    if (await readSelector(selector) !== initialRelease) throw new Error('bootstrap selector changed during cutover verification');
    return {mode: 'apply', target, backup, selector: initialRelease, installed_verified: true, bridgePid: activated.bridge[0].pid};
  } catch (error) {
    try {
      await copyFile(backup, target);
      await chmod(target, originalMode);
      await restart(SERVICE);
      const restored = await stableService({inspect, sleep, now, startupGraceMs, stabilityMs, mustChangeBridgePid: beforeBridgePid});
      if (await readSelector(selector) !== initialRelease) throw new Error('selector changed during bootstrap rollback verification');
      throw new ReleaseOperationError('bootstrap migration failed; rolled_back_verified to the saved forwarder', 'rolled_back_verified',
        {target, restoredBridgePid: restored.bridge[0].pid, backup});
    } catch (rollbackError) {
      if (rollbackError instanceof ReleaseOperationError) throw rollbackError;
      throw new ReleaseOperationError('bootstrap migration failed; rollback_failed: ' + rollbackError.message,
        'rollback_failed', {target, backup});
    }
  }
}

function command(args) {
  const options = {apply: false, command: 'activate', root: PRODUCTION_ROOT, ownerUid: process.getuid?.() ?? 0};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--apply') options.apply = true;
    else if (arg === '--install-bootstrap') options.command = 'install';
    else if (arg === '--release' && args[i + 1]) options.sha = args[++i];
    else if (arg === '--root' && args[i + 1]) options.root = path.resolve(args[++i]);
    else if (arg === '--owner-uid' && args[i + 1] && /^\d+$/.test(args[i + 1])) options.ownerUid = Number(args[++i]);
    else if (arg === '--registered-entrypoint' && args[i + 1]) options.registeredEntrypoint = args[++i];
    else if (arg === '--initial-release' && args[i + 1]) options.initialRelease = args[++i];
    else if (arg === '--original-backup' && args[i + 1]) options.originalBackup = path.resolve(args[++i]);
    else if (arg === '--original-backup-sha256' && args[i + 1]) options.originalBackupSha256 = args[++i];
    else throw new Error('unknown or incomplete argument: ' + arg);
  }
  if (options.command === 'activate' && !options.sha) throw new Error('usage: node activate-release.mjs --release <40-hex-sha> [--root <trusted-root>] [--apply]');
  if (options.command === 'install' && (!options.registeredEntrypoint || !options.initialRelease || !options.originalBackup || !options.originalBackupSha256)) {
    throw new Error('bootstrap migration requires --registered-entrypoint, --initial-release, --original-backup, and --original-backup-sha256');
  }
  return options;
}

async function productionRestart(service) {
  if (service !== SERVICE) throw new Error('refusing to restart an unapproved service');
  const r = spawnSync('systemctl', ['restart', SERVICE], {stdio: 'ignore', timeout: 20_000});
  if (r.status !== 0) throw new Error('systemctl restart ' + SERVICE + ' failed');
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    const args = command(process.argv.slice(2));
    if (args.apply && process.getuid?.() !== 0) throw new Error('apply operations require root; dry-run is read-only and does not require root');
    if (args.apply && args.ownerUid !== 0) throw new Error('--apply requires root-owned release files; set --owner-uid 0');
    const common = {root: args.root, apply: args.apply, uid: args.apply ? 0 : args.ownerUid, checkParents: args.apply};
    const restart = args.apply ? productionRestart : undefined;
    const inspect = args.apply ? () => inspectService({root: args.root}) : undefined;
    let result;
    if (args.command === 'install') result = await installBootstrap({...common, ...args, restart, inspect});
    else result = await activateRelease({...common, sha: args.sha, restart, inspect});
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch (error) {
    process.stderr.write(JSON.stringify({status: error.status || 'failed', message: error.message, details: error.details || {}}) + '\n');
    process.exitCode = 1;
  }
}
