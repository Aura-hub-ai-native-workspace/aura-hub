/**
 * taskGen — per-task proposal generation ("Run Task"). Replaces the v1
 * `stepGen.ts` for the new `MissionTask` shape.
 * ==================================================================
 * Only called for tasks with a real `targetFile` (`kind === 'file-operation'`)
 * — manual/review/approval/documentation/research tasks with no single
 * concrete file are resolved directly by the human. Reads the REAL
 * current file (if it exists) and asks for the complete rewritten
 * contents, grounded in the task's own description and the goal's
 * rationale — never a wider rewrite. Same single-shot JSON-mode
 * convention as every other AI call in this app. Never writes anything
 * — the caller (`workspace.ts#acceptMissionTask`) is the only place a
 * task's proposal is ever written to disk, and only after an explicit
 * human Accept.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { PipelineManager } from '../pipeline';
import { parseModelJson } from '../jsonMode';
import { resolveInsideProject } from '../diagnosis/repoScan';
import type { MissionGoal, MissionTask, TaskProposal } from './types';

function languageForPath(relPath: string): string {
  const ext = path.extname(relPath).toLowerCase();
  const map: Record<string, string> = {
    '.ts': 'typescript', '.tsx': 'typescript', '.js': 'javascript', '.jsx': 'javascript',
    '.md': 'markdown', '.json': 'json', '.py': 'python', '.rs': 'rust', '.go': 'go',
  };
  return map[ext] ?? 'plaintext';
}

const SYSTEM =
  'You output ONLY valid JSON, no prose, no code fences. The JSON object must have exactly these keys: ' +
  '"explanation" (short string — what you changed/created and why), ' +
  '"newCode" (string — the COMPLETE file contents after your change, in full, not a diff or a snippet). ' +
  'Make the minimum change needed to accomplish the task described below — do not perform a wider rewrite, ' +
  'do not touch unrelated content, and preserve the file\'s real existing style and conventions.';

export interface TaskGenResult {
  ok: boolean;
  proposal: TaskProposal;
  isNewFile: boolean;
  absFilePath: string;
}

export async function generateTaskProposal(
  pipeline: PipelineManager,
  projectPath: string,
  task: MissionTask,
  goal: MissionGoal,
  missionText: string,
  signal?: AbortSignal,
): Promise<TaskGenResult> {
  // This is the AURA AI node's executor. Git operations are executed by the
  // governed git node — never here.
  if (task.kind !== 'file-operation' || !task.targetFile) {
    return {
      ok: false,
      isNewFile: false,
      absFilePath: projectPath,
      proposal: {
        explanation: '',
        newCode: null,
        error: { type: 'invalid_task', message: `task kind "${task.kind}" is not handled by the AURA AI node`, retryable: false },
      },
    };
  }
  const relPath = task.targetFile as string;
  const absFilePath = resolveInsideProject(projectPath, relPath);
  const isNewFile = !fs.existsSync(absFilePath);
  const currentContent = isNewFile ? null : fs.readFileSync(absFilePath, 'utf8');
  const language = languageForPath(relPath);

  const user = [
    `Mission: ${missionText}`,
    `Goal: ${goal.title} — ${goal.rationale}`,
    `Task: ${task.title}`,
    `Task description: ${task.description}`,
    `File: ${relPath}  Language: ${language}`,
    isNewFile
      ? 'This file does not exist yet — create it from scratch to accomplish the task.'
      : `Current file contents:\n\`\`\`${language}\n${currentContent}\n\`\`\``,
    'Respond with ONLY the JSON object described in the system message.',
  ].join('\n');

  const res = await pipeline.generate({ system: SYSTEM, user, json: true }, signal);
  if (!res.ok) {
    return { ok: false, isNewFile, absFilePath, proposal: { explanation: '', newCode: null, error: res.error } };
  }

  try {
    const parsed = parseModelJson(res.text);
    return {
      ok: true, isNewFile, absFilePath,
      proposal: {
        explanation: typeof parsed.explanation === 'string' ? parsed.explanation : '',
        newCode: typeof parsed.newCode === 'string' ? parsed.newCode : null,
      },
    };
  } catch (e) {
    return {
      ok: false, isNewFile, absFilePath,
      proposal: { explanation: '', newCode: null, error: { type: 'parse_error', message: (e as Error).message, retryable: true } },
    };
  }
}
