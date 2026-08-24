import type { CliAllowList, CliAllowRule } from './models.js';

export type AllowVerdict = { verdict: 'allow' } | { verdict: 'deny'; reason: string };

/**
 * Evaluate a CLI allow-list against an argv array before spawn.
 *
 * Rules are token patterns matched as a prefix of argv; `*` matches a single
 * argv token. A deny rule match always rejects. When the allow list is
 * non-empty, at least one allow rule must match. An empty allow list means the
 * entry is explicitly trusted (same trust decision the Market makes for
 * home-stdio entries).
 */
export function evaluateAllowList(argv: string[], rules: CliAllowList): AllowVerdict {
  for (const rule of rules.deny) {
    if (ruleMatches(rule, argv)) {
      return { verdict: 'deny', reason: `argv matches deny rule: ${rule.join(' ')}` };
    }
  }
  if (rules.allow.length > 0) {
    if (!rules.allow.some((rule) => ruleMatches(rule, argv))) {
      return { verdict: 'deny', reason: 'argv does not match any allow rule' };
    }
  }
  return { verdict: 'allow' };
}

function ruleMatches(rule: CliAllowRule, argv: string[]): boolean {
  if (argv.length < rule.length) return false;
  return rule.every((token, index) => token === '*' || token === argv[index]);
}
