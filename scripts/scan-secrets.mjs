import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';

// Heuristics only: these rules cannot establish that a repository is secret-free.
// The rule declarations themselves are excluded from scanning this file.
const patterns = [
  ['tunnel token', /\btunnel_[a-z0-9]{32}\b/],
  ['API token', /\b(?:sk-proj-|mdt_live_|ghp_|github_pat_)[A-Za-z0-9_-]{20,}\b/],
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ['Tailscale key', /\btskey-(?:auth-)?[A-Za-z0-9_-]{20,}\b/],
  ['Tailscale hostname', /\b(?:[a-zA-Z0-9-]+\.)+ts\.net\b/],
  ['Tailscale address', /\b100\.(?:[6-9][0-9]|1[0-1][0-9]|12[0-7])\.[0-9]{1,3}\.[0-9]{1,3}\b/],
  ['email address', /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/],
  ['local home path', /\/home\/ubuntu\b/],
  ['private host', /\bjumbo-arm-phoenix\b/i],
  ['private repository', /\bJonbinC\/hapi-copilot\b(?!-public)/]
];

const files = execFileSync('git', ['ls-files', '-z'], {encoding: 'utf8'}).split('\0').filter(Boolean);
const findings = [];
let binaryCount = 0;
for (const file of files) {
  const bytes = readFileSync(file);
  if (bytes.includes(0)) { binaryCount++; continue; }
  let content = bytes.toString('utf8');
  if (file === 'scripts/scan-secrets.mjs') {
    content = content.replace(/const patterns = \[[\s\S]*?\n\];/, '');
  }
  for (const [name, pattern] of patterns) {
    if (pattern.test(content)) findings.push(`${file}: ${name}`);
  }
}
if (findings.length) {
  console.error('Potential secret or private reference (values omitted):\n' + findings.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Release-pattern scan passed for ${files.length - binaryCount} tracked text files (${binaryCount} binary files skipped). Heuristics are not a guarantee.`);
}
