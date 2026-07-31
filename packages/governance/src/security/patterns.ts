/**
 * Shared security patterns — used by the Security Engine and Quality Gates.
 * ==================================================================
 * Every pattern is an explicit, conservative matcher. Placeholder
 * detection prevents example values from being reported as secrets.
 */

export const PLACEHOLDER_PATTERN = /(xxx|xxxx|your[-_]|example|changeme|sample|placeholder|<[^>]*>|dummy)/i;

export const SECRET_PATTERNS: Array<[string, RegExp]> = [
  ['AWS access key', /\b(AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['Private key block', /-----BEGIN (RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/],
  ['GitHub token', /\b(ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{20,})\b/],
  ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['JWT token', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/],
  ['Secret assignment', /\b(SECRET|TOKEN|API_KEY|APIKEY|CLIENT_SECRET|PASSWORD|PASSWD)\s*[:=]\s*['"`][^'"`\s]{8,}['"`]/],
];

export const UNSAFE_PATTERNS: Array<[string, RegExp]> = [
  ['eval', /\beval\s*\(/],
  ['new Function', /\bnew\s+Function\s*\(/],
  ['child_process exec', /(?:child_process|node:child_process)["']?\s*[,)]?\s*(?:exec|execSync)\s*\(|\bexecSync?\s*\(/],
  ['shell: true', /shell\s*:\s*true/],
  ['dangerouslySetInnerHTML', /dangerouslySetInnerHTML/],
  ['document.write / innerHTML', /document\.write\s*\(|\.innerHTML\s*=/],
  ['vm.runInNewContext', /(?:vm|node:vm)[\s\S]{0,40}runInNewContext\s*\(|\brunInNewContext\s*\(/],
];

export const PERMISSION_PATTERNS: Array<[string, RegExp]> = [
  ['chmod 777', /chmod\s+(-R\s+)?(0?777|a\+rwx|ugo\+rwx)/],
  ['unsafe-perm', /--unsafe-perm/],
  ['0o666 write mode', /(?:mode\s*:\s*0o?666|0o?666\s*[),])/],
  ['sudo in scripts', /sudo\s+/],
];

export const AUTH_PATTERNS: Array<[string, RegExp]> = [
  ['Hardcoded JWT secret', /\b(jwt[_-]?secret|JWT_SECRET|SESSION_SECRET)\s*[:=]\s*['"`][^'"`\s]{8,}['"`]/],
];
