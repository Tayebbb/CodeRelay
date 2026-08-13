import type { ProjectRecord } from '../projects/registry.js';

export interface ParsedTask {
  projectId: string | null;
  prompt: string;
  /** How the project was identified, for transparency in the reply. */
  matchedOn: string | null;
  candidates: ProjectRecord[];
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * Best-effort local parsing of a free-form request. Deliberately rule-based:
 * it costs nothing, is deterministic, and never sends your message to a model
 * just to pick a project.
 */
export function parseNaturalTask(text: string, projects: ProjectRecord[]): ParsedTask {
  const prompt = text.trim();
  const haystack = normalize(prompt);

  const matches = projects.filter((project) => {
    const byId = normalize(project.id);
    const byName = normalize(project.name);
    return (byId.length >= 3 && haystack.includes(byId)) || (byName.length >= 3 && haystack.includes(byName));
  });

  if (matches.length === 1) {
    return { projectId: matches[0]!.id, prompt, matchedOn: matches[0]!.name, candidates: [] };
  }
  if (matches.length > 1) {
    // Prefer the longest name match — "medilink-api" beats "medilink".
    const sorted = [...matches].sort((a, b) => normalize(b.name).length - normalize(a.name).length);
    const best = sorted[0]!;
    const runnerUp = sorted[1]!;
    if (normalize(best.name).length > normalize(runnerUp.name).length) {
      return { projectId: best.id, prompt, matchedOn: best.name, candidates: [] };
    }
    return { projectId: null, prompt, matchedOn: null, candidates: sorted };
  }

  return { projectId: null, prompt, matchedOn: null, candidates: [] };
}

/** Split "/task <selector> <rest>" into its two parts. */
export function splitTaskCommand(argument: string): { selector: string; prompt: string } | null {
  const trimmed = argument.trim();
  if (!trimmed) return null;
  const match = /^(\S+)\s+([\s\S]+)$/.exec(trimmed);
  if (!match) return null;
  return { selector: match[1]!, prompt: match[2]!.trim() };
}
