/**
 * Pre-flight risk classification of a task prompt.
 *
 * The Copilot CLI's permission model is declared up front, so we cannot
 * interactively approve an individual tool call mid-run. Approval therefore
 * happens at the task boundary: a prompt that asks for something dangerous is
 * held until the operator approves it in Telegram. The CLI deny-list
 * (see copilot/permissions.ts) remains the hard enforcement layer.
 */

export type RiskLevel = 'normal' | 'elevated';

export interface RiskRule {
  id: string;
  description: string;
  pattern: RegExp;
}

export const RISK_RULES: RiskRule[] = [
  {
    id: 'destructive-files',
    description: 'Bulk file deletion',
    pattern: /\b(delete|remove|wipe|purge|nuke|clear)\b[^.]{0,40}\b(all|every|entire|whole|directory|folder|repo|repository|node_modules|files)\b/i,
  },
  {
    id: 'db-migration',
    description: 'Database migration or schema change',
    pattern: /\b(migration|migrate|drop\s+table|drop\s+database|truncate|alter\s+table|prisma\s+migrate|alembic|flyway|liquibase)\b/i,
  },
  {
    id: 'system-packages',
    description: 'Installing system-level packages or tools',
    pattern: /\b(apt|apt-get|yum|dnf|pacman|brew|choco|chocolatey|winget|scoop|snap)\b|\binstall\b[^.]{0,30}\b(globally|system[- ]wide|-g\b)/i,
  },
  {
    id: 'outside-project',
    description: 'Operating outside the project directory',
    pattern: /\b(c:\\|\/etc\/|\/usr\/|\/var\/|%appdata%|~\/\.ssh|\.ssh\b|system32|program files|home directory|outside the project|another project)\b/i,
  },
  {
    id: 'network-config',
    description: 'Firewall or network configuration',
    pattern: /\b(firewall|iptables|netsh|ufw|port forward|open a port|dns record|hosts file)\b/i,
  },
  {
    id: 'credentials',
    description: 'Accessing credentials or secrets',
    pattern: /\b(\.env\b|secret|credential|api[- ]?key|private key|password|token|keychain|keystore|ssh key)\b/i,
  },
  {
    id: 'deployment',
    description: 'Deployment or release to an environment',
    pattern: /\b(deploy|release to|publish to|production|prod\b|staging|kubernetes|kubectl|terraform|docker push|npm publish)\b/i,
  },
  {
    id: 'push',
    description: 'Pushing to a remote repository',
    pattern: /\b(git\s+push|push (to|the) (remote|origin|github)|open a (pr|pull request)|create a pull request|force[- ]push)\b/i,
  },
  {
    id: 'destructive-git',
    description: 'Destructive git operation',
    pattern: /\b(reset\s+--hard|force[- ]push|rewrite history|filter-branch|git\s+clean\s+-|drop the branch|delete the branch)\b/i,
  },
  {
    id: 'shell-escape',
    description: 'Arbitrary shell or privilege escalation',
    pattern: /\b(sudo|runas|as administrator|elevated|chmod\s+777|curl[^|]*\|\s*(ba)?sh|iwr[^|]*\|\s*iex)\b/i,
  },
];

export interface RiskAssessment {
  level: RiskLevel;
  matched: RiskRule[];
  reason: string | null;
}

/** Classify a natural-language task prompt. */
export function assessRisk(prompt: string): RiskAssessment {
  const matched = RISK_RULES.filter((rule) => rule.pattern.test(prompt));
  if (matched.length === 0) {
    return { level: 'normal', matched: [], reason: null };
  }
  return {
    level: 'elevated',
    matched,
    reason: matched.map((m) => m.description).join('; '),
  };
}
