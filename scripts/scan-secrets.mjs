import {readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';

const patterns = [
  /\btunnel_[a-z0-9]{32}\b/g,
  /\b(?:sk-proj-|mdt_live_|ghp_|github_pat_)[A-Za-z0-9_-]{20,}\b/g,
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g,
  /\btskey-(?:auth-)?[A-Za-z0-9_-]{20,}\b/g,
  /\b(?:[a-zA-Z0-9-]+\.)+ts\.net\b/g,
  /\b100\.(?:[6-9][0-9]|1[0-1][0-9]|12[0-7])\.[0-9]{1,3}\.[0-9]{1,3}\b/g,
  /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g,
  /\/home\/ubuntu\b/g,
  /\bjumbo-arm-phoenix\b/gi,
  /\bJonbinC\/hapi-copilot\b(?!-public)/g
];

const findings = [];

function visit(dir) {
  for (const e of readdirSync(dir, {withFileTypes: true})) {
    if (['.git', 'node_modules', 'tests', 'state'].includes(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      visit(p);
    } else {
      const text = readFileSync(p, 'utf8');
      for (const pattern of patterns) {
        if (pattern.test(text)) findings.push(p);
      }
    }
  }
}

visit('.');
if (findings.length) {
  console.error('Potential secret/private configuration in:', [...new Set(findings)].join(', '));
  process.exit(1);
}
console.log('Deep release scan passed: no private infrastructure, tokens, or personal identifiers found.');
