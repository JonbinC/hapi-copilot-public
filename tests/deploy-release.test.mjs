import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, chmod, lstat, readFile, rm, symlink, unlink, copyFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {activateRelease, inspectService, installBootstrap, SERVICE, validateRelease} from '../deploy/activate-release.mjs';
import {resolveSelectedEntrypoint, runBootstrap} from '../deploy/bridge-bootstrap.mjs';

const OLD = 'a'.repeat(40), NEXT = 'b'.repeat(40), INITIAL = 'c'.repeat(40);
const uid = process.getuid?.() ?? 0;
const bootstrapSource = fileURLToPath(new URL('../deploy/bridge-bootstrap.mjs', import.meta.url));
const group = '/system.slice/hapi-console-tunnel.service';

function serviceState({active = true, tunnelPid = 10, bridgePid = 50} = {}) {
  const identity = pid => ({pid, startTime: String(pid * 100)});
  return {active, cgroup: group, cgroupVerified: true, tunnel: tunnelPid ? [identity(tunnelPid)] : [], bridge: bridgePid ? [identity(bridgePid)] : []};
}

async function fixture(t, base = os.tmpdir()) {
  const root = await mkdtemp(path.join(base, 'hapi release ;$()-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  await mkdir(path.join(root, 'releases'), {mode: 0o755});
  for (const sha of [OLD, NEXT]) {
    await mkdir(path.join(root, 'releases', sha, 'server'), {recursive: true, mode: 0o755});
    await writeFile(path.join(root, 'releases', sha, 'server', 'index.mjs'), '// staged fixture\n', {mode: 0o644});
  }
  await writeFile(path.join(root, 'current-release'), OLD + '\n', {mode: 0o644});
  return root;
}

test('bootstrap adjusts process.argv[1] and passes Node ESM direct-launch check', async t => {
  const root = await fixture(t);
  const marker = path.join(root, 'direct-launch-ok');
  const target = path.join(root, 'releases', NEXT, 'server', 'index.mjs');
  await writeFile(target, `import {writeFileSync} from 'node:fs'; import {fileURLToPath} from 'node:url'; import path from 'node:path'; if (path.resolve(process.argv[1]) !== path.resolve(fileURLToPath(import.meta.url))) process.exit(31); writeFileSync(${JSON.stringify(marker)}, 'ok');`, {mode: 0o644});
  await writeFile(path.join(root, 'current-release'), NEXT + '\n', {mode: 0o644});
  const oldArgv = process.argv[1];
  try {
    await runBootstrap({root, uid, checkParents: false});
    assert.equal(await readFile(marker, 'utf8'), 'ok');
    assert.equal(process.argv[1], target);
  } finally { process.argv[1] = oldArgv; }
});

test('hapi-console UID distinct from release owner can read selector by POSIX mode', async t => {
  const root = await fixture(t);
  // Model the deployment owner as root and hapi-console as an unrelated UID.
  // The CI user need not be root: these lstat checks verify the POSIX "other"
  // read/search bits that govern access for an unrelated service account.
  await chmod(root, 0o755);
  const serviceUid = uid === 64001 ? 64002 : 64001;
  assert.notEqual(serviceUid, uid);
  assert.notEqual(serviceUid, 0);
  for (const directory of [root, path.join(root, 'releases')]) {
    const stat = await lstat(directory);
    assert.equal(stat.uid, uid);
    assert.ok(stat.mode & 0o001, 'hapi-console can traverse parent directory');
    assert.equal(stat.mode & 0o022, 0, 'untrusted users cannot change parent directory');
  }
  const selector = path.join(root, 'current-release');
  const stat = await lstat(selector);
  assert.equal(stat.uid, uid, 'selector remains owned by the deployment owner');
  assert.equal(stat.mode & 0o777, 0o644);
  assert.ok(stat.mode & 0o004, 'an unrelated hapi-console UID can read the selector');
  assert.equal(stat.mode & 0o022, 0, 'hapi-console cannot modify the selector');
  assert.equal(await readFile(selector, 'utf8'), OLD + '\n');
  assert.equal(await resolveSelectedEntrypoint({root, uid, checkParents: false}), path.join(root, 'releases', OLD, 'server', 'index.mjs'));
  await chmod(selector, 0o640);
  await assert.rejects(resolveSelectedEntrypoint({root, uid, checkParents: false}), /readable by the service account/);
  await chmod(selector, 0o644);
});

test('rejects malformed selectors, traversal, symlink releases, wrong owner, and loose selector mode', async t => {
  const root = await fixture(t);
  const selector = path.join(root, 'current-release');
  await writeFile(selector, '../' + NEXT, {mode: 0o644});
  await assert.rejects(resolveSelectedEntrypoint({root, uid, checkParents: false}), /40-character/);
  await writeFile(selector, NEXT + '\n', {mode: 0o644});
  await assert.rejects(validateRelease(root, '../' + NEXT, uid, {checkParents: false}), /40-character/);
  await assert.rejects(resolveSelectedEntrypoint({root, uid: uid + 1, checkParents: false}), /owner or type/);
  const serverDir = path.join(root, 'releases', NEXT, 'server');
  await chmod(serverDir, 0o777);
  await assert.rejects(validateRelease(root, NEXT, uid, {checkParents: false}), /writable permissions/);
  await chmod(serverDir, 0o755);
  await chmod(selector, 0o664);
  await assert.rejects(resolveSelectedEntrypoint({root, uid, checkParents: false}), /writable permissions/);
  await chmod(selector, 0o600);
  await assert.rejects(resolveSelectedEntrypoint({root, uid, checkParents: false}), /readable by the service account/);
  await chmod(selector, 0o644);
  assert.equal(await resolveSelectedEntrypoint({root, uid, checkParents: false}), path.join(root, 'releases', NEXT, 'server', 'index.mjs'));
  const release = path.join(root, 'releases', NEXT);
  const moved = path.join(root, 'release-moved');
  await (await import('node:fs/promises')).rename(release, moved);
  await symlink(moved, release);
  await assert.rejects(validateRelease(root, NEXT, uid, {checkParents: false}), /directory owner or type/);
});

test('dry run validates release and never restarts or edits selector', async t => {
  const root = await fixture(t);
  let calls = 0;
  const result = await activateRelease({root, sha: NEXT, uid, checkParents: false, restart: async () => calls++});
  assert.equal(result.mode, 'dry-run');
  assert.equal(calls, 0);
  assert.equal(await readFile(path.join(root, 'current-release'), 'utf8'), OLD + '\n');
});

test('CLI dry run is read-only and does not demand root privileges', async t => {
  const root = await fixture(t, process.cwd());
  const cli = fileURLToPath(new URL('../deploy/activate-release.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [cli, '--root', root, '--release', NEXT, '--owner-uid', String(uid)], {encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).mode, 'dry-run');
  assert.equal(await readFile(path.join(root, 'current-release'), 'utf8'), OLD + '\n');
});

test('repeating the selected SHA is an idempotent no-op', async t => {
  const root = await fixture(t);
  let calls = 0;
  const result = await activateRelease({root, sha: OLD, apply: true, uid, checkParents: false, restart: async () => calls++});
  assert.equal(result.from, OLD);
  assert.equal(result.to, OLD);
  assert.equal(result.switched_verified, undefined);
  assert.equal(calls, 0);
});

test('atomic switch requires exact single service processes and reports only the existing service', async t => {
  const root = await fixture(t);
  let clock = 0;
  const restarts = [];
  const inspect = async () => restarts.length === 0 ? serviceState({bridgePid: 50}) : serviceState({bridgePid: 51});
  const result = await activateRelease({root, sha: NEXT, apply: true, uid, checkParents: false,
    restart: async service => restarts.push(service),
    inspect,
    now: () => clock, sleep: async ms => { clock += ms; },
    stabilityMs: 2000, startupGraceMs: 5000});
  assert.equal(result.switched_verified, true);
  assert.equal(result.bridgePid, 51);
  assert.deepEqual(restarts, [SERVICE]);
  assert.equal(await readFile(path.join(root, 'current-release'), 'utf8'), NEXT + '\n');
  assert.equal((await lstat(path.join(root, 'current-release'))).mode & 0o777, 0o644);
});

test('Linux process check counts only Bridge and tunnel processes inside the exact service cgroup', async t => {
  const proc = await mkdtemp(path.join(os.tmpdir(), 'hapi-proc-'));
  t.after(() => rm(proc, {recursive: true, force: true}));
  const add = async (pid, cgroup, argv) => {
    const dir = path.join(proc, String(pid));
    await mkdir(dir);
    await writeFile(path.join(dir, 'cgroup'), `0::${cgroup}\n`);
    await writeFile(path.join(dir, 'cmdline'), Buffer.from(argv.join('\0') + '\0'));
    const statFields = ['S', ...Array(18).fill('0'), String(pid * 100)];
    await writeFile(path.join(dir, 'stat'), String(pid) + ' (process) ' + statFields.join(' '));
  };
  await add(101, group, ['/usr/local/bin/tunnel-client', 'run']);
  await add(102, group + '/control', ['/usr/bin/node', '/opt/hapi-copilot/releases/' + OLD + '/server/index.mjs']);
  await add(103, '/system.slice/other.service', ['/usr/bin/node', '/opt/hapi-copilot/releases/' + NEXT + '/server/index.mjs']);
  const runner = (command, args) => {
    assert.equal(command, 'systemctl');
    if (args[0] === 'is-active') {
      assert.deepEqual(args, ['is-active', SERVICE]);
      return {status: 0, stdout: 'active\n'};
    }
    assert.deepEqual(args, ['show', SERVICE, '--property=ControlGroup', '--value']);
    return {status: 0, stdout: group + '\n'};
  };
  assert.deepEqual(await inspectService({root: '/opt/hapi-copilot', proc, runner}), {
    active: true, cgroup: group, cgroupVerified: true,
    tunnel: [{pid: 101, startTime: '10100'}],
    bridge: [{pid: 102, startTime: '10200'}],
  });
  const inactiveRunner = (command, args) => command === 'systemctl' && args[0] === 'is-active'
    ? {status: 3, stdout: 'inactive\n'} : {status: 0, stdout: group + '\n'};
  assert.equal((await inspectService({root: '/opt/hapi-copilot', proc, runner: inactiveRunner})).active, false);
});

test('failed startup verifies rollback and emits rolled_back_verified status', async t => {
  const root = await fixture(t);
  let clock = 0;
  const restarts = [];
  const inspect = async () => restarts.length === 0 ? serviceState({bridgePid: 50}) :
    restarts.length === 1 ? serviceState({active: false, tunnelPid: 0, bridgePid: 0}) : serviceState({bridgePid: 52});
  await assert.rejects(activateRelease({root, sha: NEXT, apply: true, uid, checkParents: false,
    restart: async service => restarts.push(service), inspect,
    now: () => clock, sleep: async ms => { clock += ms; },
    stabilityMs: 1000, startupGraceMs: 2500}), error => error.status === 'rolled_back_verified');
  assert.deepEqual(restarts, [SERVICE, SERVICE]);
  assert.equal(await readFile(path.join(root, 'current-release'), 'utf8'), OLD + '\n');
});

test('stability gate loss after startup also restores the old release', async t => {
  const root = await fixture(t);
  let clock = 0, afterRestartSamples = 0;
  const restarts = [];
  const inspect = async () => {
    if (restarts.length === 0) return serviceState({bridgePid: 50});
    if (restarts.length === 2) return serviceState({bridgePid: 53});
    return ++afterRestartSamples === 1 ? serviceState({bridgePid: 51}) : serviceState({bridgePid: 52});
  };
  await assert.rejects(activateRelease({root, sha: NEXT, apply: true, uid, checkParents: false,
    restart: async service => restarts.push(service), inspect,
    now: () => clock, sleep: async ms => { clock += ms; },
    stabilityMs: 2000, startupGraceMs: 5000}), error => error.status === 'rolled_back_verified');
  assert.deepEqual(restarts, [SERVICE, SERVICE]);
  assert.equal(await readFile(path.join(root, 'current-release'), 'utf8'), OLD + '\n');
});

test('an unchanged Bridge PID cannot be reported as a successful switch', async t => {
  const root = await fixture(t);
  let clock = 0;
  const restarts = [];
  const inspect = async () => restarts.length === 0 ? serviceState({bridgePid: 50}) :
    restarts.length === 1 ? serviceState({bridgePid: 50}) : serviceState({bridgePid: 52});
  await assert.rejects(activateRelease({root, sha: NEXT, apply: true, uid, checkParents: false,
    restart: async service => restarts.push(service), inspect,
    now: () => clock, sleep: async ms => { clock += ms; },
    stabilityMs: 1000, startupGraceMs: 3000}), error => error.status === 'rolled_back_verified' && /PID did not change/.test(error.message));
  assert.deepEqual(restarts, [SERVICE, SERVICE]);
  assert.equal(await readFile(path.join(root, 'current-release'), 'utf8'), OLD + '\n');
});

test('rollback failure is explicitly reported and never called verified', async t => {
  const root = await fixture(t);
  let clock = 0;
  const restarts = [];
  const inspect = async () => restarts.length === 0 ? serviceState({bridgePid: 50}) :
    serviceState({active: false, tunnelPid: 0, bridgePid: 0});
  await assert.rejects(activateRelease({root, sha: NEXT, apply: true, uid, checkParents: false,
    restart: async service => restarts.push(service), inspect,
    now: () => clock, sleep: async ms => { clock += ms; },
    stabilityMs: 1000, startupGraceMs: 1500}), error => error.status === 'rollback_failed');
  assert.deepEqual(restarts, [SERVICE, SERVICE]);
  assert.equal(await readFile(path.join(root, 'current-release'), 'utf8'), OLD + '\n');
});

test('activation refuses an unhealthy prior service before changing the selector', async t => {
  const root = await fixture(t);
  await assert.rejects(activateRelease({root, sha: NEXT, apply: true, uid, checkParents: false,
    restart: async () => {}, inspect: async () => serviceState({active: false})}), /existing service and Bridge PID identity/);
  assert.equal(await readFile(path.join(root, 'current-release'), 'utf8'), OLD + '\n');
});

test('apply cannot claim success without real restart and inspection adapters', async t => {
  const root = await fixture(t);
  await assert.rejects(activateRelease({root, sha: NEXT, apply: true, uid, checkParents: false}),
    /requires guarded service restart and active\/PID health inspection/);
  assert.equal(await readFile(path.join(root, 'current-release'), 'utf8'), OLD + '\n');
});

test('one-time migration takes explicit release and backup identity; selector precedes bootstrap replacement', async t => {
  const root = await fixture(t);
  const forwarderPath = path.join(root, 'releases', OLD, 'server', 'index.mjs');
  const forwarder = 'const target = "' + INITIAL + '"; // existing registered forwarder\n';
  await writeFile(forwarderPath, forwarder, {mode: 0o644});
  await mkdir(path.join(root, 'releases', INITIAL, 'server'), {recursive: true, mode: 0o755});
  await writeFile(path.join(root, 'releases', INITIAL, 'server', 'index.mjs'), '// staged initial release\n', {mode: 0o644});
  await unlink(path.join(root, 'current-release'));
  const backups = path.join(root, 'release-backups');
  await mkdir(backups, {mode: 0o755});
  const originalBackup = path.join(backups, 'original-index.mjs');
  const originalContents = 'operator-preserved original entrypoint\n';
  await writeFile(originalBackup, originalContents, {mode: 0o600});
  const originalBackupSha256 = createHash('sha256').update(originalContents).digest('hex');
  const stagedBootstrap = path.join(root, 'staged-bootstrap.mjs');
  await copyFile(bootstrapSource, stagedBootstrap);
  await chmod(stagedBootstrap, 0o644);
  let clock = 0;
  const restarts = [];
  const inspect = async () => restarts.length === 0 ? serviceState({bridgePid: 70}) : serviceState({bridgePid: 71});
  const args = {root, registeredEntrypoint: 'releases/' + OLD + '/server/index.mjs',
    initialRelease: INITIAL, originalBackup, originalBackupSha256, source: stagedBootstrap,
    uid, checkParents: false, inspect, restart: async service => {
      restarts.push(service);
      assert.equal(await readFile(path.join(root, 'current-release'), 'utf8'), INITIAL + '\n');
      assert.equal((await lstat(path.join(root, 'current-release'))).mode & 0o777, 0o644,
        'selector is service-readable before the registered bootstrap can launch');
      assert.match(await readFile(forwarderPath, 'utf8'), /hapi-copilot bootstrap/);
    }, now: () => clock, sleep: async ms => { clock += ms; }, startupGraceMs: 5000, stabilityMs: 1000};
  const preview = await installBootstrap({...args, apply: false, inspect: undefined, restart: undefined});
  assert.equal(preview.mode, 'dry-run');
  assert.equal(await readFile(forwarderPath, 'utf8'), forwarder);
  assert.equal(await readFile(originalBackup, 'utf8'), originalContents);
  const result = await installBootstrap({...args, apply: true});
  assert.equal(result.installed_verified, true);
  assert.deepEqual(restarts, [SERVICE]);
  assert.equal(await readFile(originalBackup, 'utf8'), originalContents);
  assert.equal(await readFile(result.backup, 'utf8'), forwarder);
  assert.equal((await lstat(result.backup)).mode & 0o777, 0o600);
});

test('failed one-time cutover restores forwarder and verifies rollback explicitly', async t => {
  const root = await fixture(t);
  const target = path.join(root, 'releases', OLD, 'server', 'index.mjs');
  const forwarder = 'forward to ' + INITIAL + '\n';
  await writeFile(target, forwarder, {mode: 0o644});
  await mkdir(path.join(root, 'releases', INITIAL, 'server'), {recursive: true, mode: 0o755});
  await writeFile(path.join(root, 'releases', INITIAL, 'server', 'index.mjs'), '// initial\n', {mode: 0o644});
  await unlink(path.join(root, 'current-release'));
  const backups = path.join(root, 'release-backups');
  await mkdir(backups, {mode: 0o755});
  const originalBackup = path.join(backups, 'original.mjs');
  const originalText = 'preserved separately\n';
  await writeFile(originalBackup, originalText, {mode: 0o600});
  const source = path.join(root, 'bootstrap-source.mjs');
  await copyFile(bootstrapSource, source);
  await chmod(source, 0o644);
  let clock = 0;
  const restarts = [];
  const inspect = async () => restarts.length === 0 ? serviceState({bridgePid: 80}) :
    restarts.length === 1 ? serviceState({active: false, tunnelPid: 0, bridgePid: 0}) : serviceState({bridgePid: 82});
  await assert.rejects(installBootstrap({
    root, registeredEntrypoint: 'releases/' + OLD + '/server/index.mjs', initialRelease: INITIAL,
    originalBackup, originalBackupSha256: createHash('sha256').update(originalText).digest('hex'),
    source, apply: true, uid, checkParents: false, inspect,
    restart: async service => restarts.push(service), now: () => clock, sleep: async ms => { clock += ms; },
    startupGraceMs: 1500, stabilityMs: 1000,
  }), error => error.status === 'rolled_back_verified');
  assert.equal(await readFile(target, 'utf8'), forwarder);
  assert.equal(await readFile(path.join(root, 'current-release'), 'utf8'), INITIAL + '\n');
  assert.equal(await readFile(originalBackup, 'utf8'), originalText);
  assert.deepEqual(restarts, [SERVICE, SERVICE]);
});
