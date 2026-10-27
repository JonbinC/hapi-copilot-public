import packageInfo from '../package.json' with { type: 'json' };

export const VERSION = packageInfo.version;

export function codeIdentity(moduleUrl = import.meta.url) {
  const match = new URL(moduleUrl).pathname.match(/\/releases\/([a-f0-9]{40})\//i);
  return {
    code_revision: match ? match[1].toLowerCase() : null,
    revision_source: match ? 'release_directory_name' : null,
  };
}
