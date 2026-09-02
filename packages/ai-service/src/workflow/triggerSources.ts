/**
 * Host-side trigger adapters for the Workflow TriggerScheduler (Phase 6).
 * ==================================================================
 * The Workflow package is pure — it defines `TriggerEventSource` and
 * the scheduler owns registration. The HOST owns the I/O:
 *
 *   FileChangeEventSource  → fs.watch on project paths
 *   GitEventSource         → poll git refs via the shared git() primitive
 *   MissionEventSource     → poll MissionStore state transitions
 *
 * Each source implements the workflow package's TriggerEventSource:
 * `start(config, context)` returns a stop function. There is exactly
 * one git primitive, one MissionStore, one project registry — these
 * adapters only observe them, they do not duplicate authority.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { TriggerEventSource, EventSourceContext } from '@aura/workflow';
import type { GitEventName, MissionEventName, TriggerNodeConfig } from '@aura/workflow';
import { git } from '../exec/process';
import type { MissionStore } from '../mission/store';

export interface ProjectResolver {
  /** Map a projectId to its working directory, or null when unknown. */
  resolve(projectId: string | null): string | null;
}

/** Debounce helper: fold bursts into one fire after `quietMs`. */
function debounce(quietMs: number, emit: () => void): () => void {
  let t: ReturnType<typeof setTimeout> | null = null;
  return () => {
    if (t) clearTimeout(t);
    t = setTimeout(emit, quietMs);
  };
}

/* ══════════════════════════════════════════════════════════════════
   File change source
   ══════════════════════════════════════════════════════════════════ */

export interface FileChangeSourceOptions {
  /** Map a projectId to its working directory. */
  projects: ProjectResolver;
  /** Watch polling interval when fs.watch is unavailable (ms). */
  pollMs?: number;
  /** Quiet window after a burst of events (ms). Default 500. */
  quietMs?: number;
  /** Match filter for relative paths. */
  matches?(relPath: string, match: string | undefined): boolean;
}

/** Simple glob: `*` matches within a path segment; `**` crosses segments. */
export function globMatch(relPath: string, pattern: string | undefined): boolean {
  if (!pattern) return true;
  if (pattern === '*') return !relPath.includes('/');
  const re = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '.*');
  return new RegExp(`^${re}$`).test(relPath);
}

export function createFileChangeEventSource(opts: FileChangeSourceOptions): TriggerEventSource {
  const quietMs = opts.quietMs ?? 500;
  return {
    type: 'file-change',
    start(config: TriggerNodeConfig, context: EventSourceContext) {
      const root = opts.projects.resolve(context.projectId);
      if (!root) return () => {};
      const paths = config.type === 'file-change' ? config.paths : [];
      const watchers = new Set<fs.FSWatcher>();
      const stopped = { value: false };
      const fireDebounced = debounce(quietMs, () => {
        if (!stopped.value) context.fire({ source: 'file-change', at: new Date().toISOString() });
      });
      for (const p of paths) {
        const target = path.resolve(root, p);
        if (!fs.existsSync(target)) continue;
        try {
          const w = fs.watch(target, { recursive: fs.existsSync(target) && fs.statSync(target).isDirectory() }, () => {
            fireDebounced();
          });
          watchers.add(w);
        } catch {
          // fs.watch can fail (ENOSPC, inotify limits) — fall back to polling.
        }
      }
      if (watchers.size === 0) {
        const pollMs = opts.pollMs ?? 2000;
        const poll = setInterval(() => fireDebounced(), pollMs);
        return () => {
          stopped.value = true;
          clearInterval(poll);
        };
      }
      return () => {
        stopped.value = true;
        for (const w of watchers) w.close();
        watchers.clear();
      };
    },
  };
}

/* ══════════════════════════════════════════════════════════════════
   Git event source
   ══════════════════════════════════════════════════════════════════ */

export interface GitSourceOptions {
  projects: ProjectResolver;
  /** Poll interval (ms). Default 30s. Testable via constructor. */
  pollMs?: number;
}

interface GitSnapshot {
  head: string;
  headParents: number;
  branch: string;
  refs: string[];
  tags: string[];
}

async function gitSnapshot(cwd: string): Promise<GitSnapshot | null> {
  const head = await git(['rev-parse', '--short=8', 'HEAD'], { cwd });
  if (head.code !== 0) return null;
  const parents = await git(['log', '-1', '--pretty=%P'], { cwd });
  const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
  const refs = await git(['for-each-ref', '--format=%(refname) %(objectname)', 'refs/remotes'], { cwd });
  const tags = await git(['tag'], { cwd });
  return {
    head: head.out.trim(),
    headParents: parents.out.trim().split(/\s+/).filter(Boolean).length,
    branch: branch.out.trim(),
    refs: refs.out.trim().split('\n').filter(Boolean).sort(),
    tags: tags.out.trim().split('\n').filter(Boolean).sort(),
  };
}

export function createGitEventSource(opts: GitSourceOptions): TriggerEventSource {
  const pollMs = opts.pollMs ?? 30_000;
  return {
    type: 'git-event',
    start(config: TriggerNodeConfig, context: EventSourceContext) {
      const root = opts.projects.resolve(context.projectId);
      if (!root) return () => {};
      const events = config.type === 'git-event' ? config.events : [];
      let prev: GitSnapshot | null = null;
      let stopped = false;
      const poll = async () => {
        if (stopped) return;
        const cur = await gitSnapshot(root);
        if (!cur || !prev) { prev = cur; return; }
        const fired: GitEventName[] = [];
        if (cur.head !== prev.head) {
          fired.push('commit');
          if (cur.headParents > 1 && prev.headParents === 1) fired.push('merge');
        }
        if (cur.branch !== prev.branch) fired.push('branch');
        if (cur.refs.join('\n') !== prev.refs.join('\n')) fired.push('push');
        if (cur.tags.join('\n') !== prev.tags.join('\n')) fired.push('tag');
        prev = cur;
        const matched = fired.filter((e) => events.length === 0 || events.includes(e));
        if (matched.length > 0 && !stopped) {
          context.fire({ source: 'git-event', events: matched, at: new Date().toISOString() });
        }
      };
      void poll().catch(() => {});
      const timer = setInterval(() => void poll().catch(() => {}), pollMs);
      return () => {
        stopped = true;
        clearInterval(timer);
      };
    },
  };
}

/* ══════════════════════════════════════════════════════════════════
   Mission event source
   ══════════════════════════════════════════════════════════════════ */

export interface MissionSourceOptions {
  projects: ProjectResolver;
  missions: MissionStore;
  /** Poll interval (ms). Default 5s. */
  pollMs?: number;
}

interface MissionState {
  approval: 'pending' | 'approved' | 'rejected';
  execution: string;
}

/** Derive the observable lifecycle state of a mission record. */
function missionStateOf(m: { approval: MissionRecordApproval; execution?: MissionExecutionLike }): MissionState {
  return {
    approval: m.approval?.status ?? 'pending',
    execution: m.execution?.status ?? 'idle',
  };
}

export function createMissionEventSource(opts: MissionSourceOptions): TriggerEventSource {
  const pollMs = opts.pollMs ?? 5000;
  return {
    type: 'mission-event',
    start(config: TriggerNodeConfig, context: EventSourceContext) {
      const projectId = context.projectId;
      if (!projectId) return () => {};
      const root = opts.projects.resolve(projectId);
      if (!root) return () => {};
      const events = config.type === 'mission-event' ? config.events : [];
      const onlyId = config.type === 'mission-event' ? config.missionId : undefined;
      const seen = new Map<string, MissionState>();
      let baseline = true;
      let stopped = false;

      const poll = () => {
        if (stopped) return;
        for (const summary of opts.missions.list(projectId)) {
          if (onlyId && summary.id !== onlyId) continue;
          const rec = opts.missions.get(projectId, summary.id);
          if (!rec) continue;
          const state = missionStateOf(rec);
          const prev = seen.get(rec.id);
          seen.set(rec.id, state);
          if (baseline) continue; // first poll is the baseline, not an event
          const fired: MissionEventName[] = [];
          if (!prev) {
            fired.push('created');
          } else {
            if (prev.approval === 'pending' && state.approval === 'approved') fired.push('approved');
            if (state.execution !== prev.execution) {
              if (state.execution === 'running') fired.push('started');
              if (state.execution === 'completed') fired.push('completed');
              if (state.execution === 'failed') fired.push('failed');
            }
          }
          if (events.length > 0) {
            for (let i = fired.length - 1; i >= 0; i--) {
              if (!events.includes(fired[i]!)) fired.splice(i, 1);
            }
          }
          if (fired.length > 0 && !stopped) {
            context.fire({ source: 'mission-event', missionId: rec.id, events: fired, at: new Date().toISOString() });
          }
        }
        baseline = false;
      };
      poll();
      const timer = setInterval(poll, pollMs);
      return () => {
        stopped = true;
        clearInterval(timer);
      };
    },
  };
}

/* — structural types (avoid deep imports in this adapter) — */
type MissionRecordApproval = { status?: 'pending' | 'approved' | 'rejected'; at?: string };
type MissionExecutionLike = { status?: string };