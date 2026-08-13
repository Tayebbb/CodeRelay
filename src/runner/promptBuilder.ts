import type { ProjectRecord } from '../projects/registry.js';

export interface PromptBuilderInput {
  userRequest: string;
  project: ProjectRecord;
  testCommand: string | null;
  buildCommand: string | null;
  attempt: number;
  failureContext: string | null;
  /** When false, the agent must leave committing to this application. */
  autoCommit: boolean;
}

/**
 * Wrap the operator's request with the operating rules for an unattended run.
 * These rules complement (not replace) the CLI permission flags and the custom
 * agent definition in `.github/agents/remote-engineer.md`.
 */
export function buildTaskPrompt(input: PromptBuilderInput): string {
  const sections: string[] = [];

  sections.push(
    [
      'You are running UNATTENDED on the operator\'s personal computer, triggered remotely.',
      'Nobody can answer questions. Make reasonable decisions and proceed.',
      '',
      `Project: ${input.project.name}`,
      `Working directory: ${input.project.path}`,
      input.project.description ? `Description: ${input.project.description}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
  );

  sections.push(
    [
      'OPERATING RULES',
      '1. Inspect before you modify. Understand the existing architecture and follow its conventions.',
      '2. Make the smallest correct change. Do not refactor or reformat unrelated code.',
      '3. Stay inside the working directory. Never read or write outside it.',
      '4. Never read, print, echo, or copy secrets: .env files, credentials, private keys, tokens.',
      '   If a secret value is required, refer to it by variable name only.',
      '5. Never delete files in bulk, never run destructive git commands, never push to a remote.',
      '6. Never install system-level packages and never change machine configuration.',
      '7. Preserve uncommitted work you find. Do not revert or discard changes you did not make.',
      input.autoCommit
        ? '8. Commit your work when finished.'
        : '8. Do NOT create a git commit. The supervising process stages and commits after verification.',
      '9. If you cannot complete the task, stop and explain precisely what blocked you.',
    ].join('\n'),
  );

  const verification: string[] = ['VERIFICATION'];
  if (input.testCommand) verification.push(`- Tests are run by the supervisor with: ${input.testCommand}`);
  if (input.buildCommand) verification.push(`- Build is run by the supervisor with: ${input.buildCommand}`);
  if (input.testCommand || input.buildCommand) {
    verification.push('- You may run these yourself to check your work before finishing.');
  } else {
    verification.push('- No test or build command was detected. Verify your change by reading the code carefully.');
  }
  sections.push(verification.join('\n'));

  if (input.attempt > 0 && input.failureContext) {
    sections.push(
      [
        `RECOVERY ATTEMPT ${input.attempt}`,
        'Your previous attempt did not pass verification. Diagnose the root cause from the output below',
        'and fix it. Do not revert your earlier work wholesale unless it is genuinely wrong.',
        '',
        '```',
        input.failureContext.slice(0, 6000),
        '```',
      ].join('\n'),
    );
  }

  sections.push(['TASK', input.userRequest].join('\n'));

  sections.push(
    [
      'WHEN FINISHED',
      'End with a short report: what you changed, which files, why, and anything the operator must know.',
      'Do not include any secret values in the report.',
    ].join('\n'),
  );

  return sections.join('\n\n---\n\n');
}
