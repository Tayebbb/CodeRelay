import type { Task } from '../domain/task.js';
import { statusEmoji } from '../domain/task.js';
import type { ProjectRecord } from '../projects/registry.js';

/**
 * All Telegram messages are sent as PLAIN TEXT (no parse_mode). That removes an
 * entire class of formatting-injection and escaping bugs when echoing code,
 * paths, or command output.
 */

export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  const hours = Math.floor(minutes / 60);
  if (hours === 0) return `${minutes}m ${seconds}s`;
  return `${hours}h ${minutes % 60}m`;
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

/** Telegram hard-caps a message at 4096 characters. */
export function clampMessage(text: string, max = 3900): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n… (truncated — use /logs for the full record)`;
}

export interface ReportInput {
  task: Task;
  projectName: string;
  model: string;
  durationMs: number;
  checkpointRef?: string;
  /** How the work was orchestrated, e.g. "complex · explorer → implementer". */
  plan?: string;
  /** 0..1 self-evaluation, and whether a review was run. */
  confidence?: number;
  reviewVerdict?: string;
}

export function formatReport(input: ReportInput): string {
  const { task, projectName, model, durationMs } = input;
  const detail = task.result;
  const lines: string[] = [];

  const heading = task.status === 'COMPLETED' ? '✅ TASK COMPLETED' : `${statusEmoji(task.status)} TASK ${task.status}`;
  lines.push(`${heading}  (#${task.id})`, '');
  lines.push(`Project: ${projectName}`);
  lines.push(`Task: ${truncate(task.prompt.split('\n')[0] ?? '', 160)}`);
  lines.push('');

  const files = detail?.filesChanged ?? [];
  if (files.length > 0) {
    lines.push('Changed:');
    for (const file of files.slice(0, 20)) lines.push(`  - ${file}`);
    if (files.length > 20) lines.push(`  … and ${files.length - 20} more`);
    if (detail && (detail.linesAdded || detail.linesRemoved)) {
      lines.push(`  (+${detail.linesAdded} / -${detail.linesRemoved})`);
    }
    lines.push('');
  } else {
    lines.push('Changed: no files were modified', '');
  }

  for (const verification of detail?.verifications ?? []) {
    lines.push(`${verification.kind === 'test' ? 'Tests' : 'Build'}: ${verification.passed ? 'passed' : 'FAILED'} (${verification.command})`);
  }
  if ((detail?.verifications ?? []).length === 0) {
    lines.push('Tests: not run (no test command detected or disabled)');
  }
  lines.push('');

  lines.push(`Commit: ${task.commitHash ? task.commitHash.slice(0, 8) : 'none'}`);
  if (task.branch) lines.push(`Branch: ${task.branch}`);
  if (input.checkpointRef) lines.push(`Checkpoint: ${input.checkpointRef}`);
  lines.push(`Duration: ${formatDuration(durationMs)}`);
  lines.push(`AI usage: ${task.usage.aiCredits.toFixed(2)} credits`);
  lines.push(`Model: ${model}`);
  if (input.plan) lines.push(`Plan: ${input.plan}`);
  if (typeof input.confidence === 'number') {
    const review = input.reviewVerdict ? `, review ${input.reviewVerdict}` : '';
    lines.push(`Confidence: ${(input.confidence * 100).toFixed(0)}%${review}`);
  }

  if (task.error) {
    lines.push('', 'Failure detail:', truncate(task.error, 1200));
  } else if (detail?.summary) {
    lines.push('', 'Agent summary:', truncate(detail.summary, 1200));
  }

  return clampMessage(lines.join('\n'));
}

export function formatTaskLine(task: Task, projectName: string): string {
  const when = new Date(task.createdAt).toLocaleString();
  return `${statusEmoji(task.status)} #${task.id} [${task.status}] ${projectName} — ${truncate(
    task.prompt.split('\n')[0] ?? '',
    60,
  )}  (${when})`;
}

export function formatProjectList(projects: ProjectRecord[]): string {
  if (projects.length === 0) {
    return 'No projects registered.\n\nRegister one on the PC with:\n  remote-agent projects add <name> <path>';
  }
  const lines = ['Registered projects:', ''];
  projects.forEach((project, index) => {
    lines.push(`${index + 1}. ${project.name}  (id: ${project.id})`);
    if (project.description) lines.push(`   ${truncate(project.description, 80)}`);
  });
  lines.push('', 'Start a task with:', '  /task 1 <what to do>', '  /task medilink <what to do>');
  return clampMessage(lines.join('\n'));
}

export const HELP_TEXT = [
  'Remote Personal Coding Agent',
  '',
  'Commands:',
  '  /help                 — this message',
  '  /status               — agent, queue and usage status',
  '  /projects             — list registered projects',
  '  /tasks [n]            — recent tasks',
  '  /task <project> <…>   — queue a coding task',
  '  /cancel <id>          — cancel a queued or running task',
  '  /retry <id>           — re-queue a finished task',
  '  /followup <id> <…>    — continue a finished task\u2019s agent session',
  '  /git [project] <op>   — status | fetch | pull | push | sync | commit',
  '  /approve <id>         — approve a pending request',
  '  /reject <id>          — reject a pending request',
  '  /logs <id>            — event log for a task',
  '  /usage                — AI credit usage and budgets',
  '',
  'You can also just describe what you want, e.g.',
  '  "Fix the authentication bug in MediLink and run the tests"',
  '',
  'Project paths are never accepted from chat — only registered projects.',
].join('\n');
