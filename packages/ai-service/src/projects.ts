/**
 * ProjectRegistry — the real, persistent project library.
 * ==================================================================
 * A project is a pointer to a real folder on disk plus metadata. The
 * registry is the single source of truth for the Projects screen, Home
 * recents, and which workspace the pipeline mounts. It persists to
 * `<home>/projects.json` and survives restarts.
 *
 * No sample projects are ever seeded. An empty registry means the user
 * has not added a project yet — the UI shows an empty state.
 */

import fs from 'node:fs';
import path from 'node:path';
import { homePath, readJsonFile, writeJsonFile } from './persist';

export interface ProjectRecord {
  id: string;
  name: string;
  /** Absolute path to the real project folder. */
  path: string;
  /** Coarse project type, detected from the folder (see profile.ts). */
  type: string;
  /** Primary language, detected from the folder. */
  language: string;
  /** Icon name (from the @aura/ui icon registry). */
  icon: string;
  /** Accent color for the project chip. */
  color: string;
  favorite: boolean;
  createdAt: string;
  lastOpenedAt: string | null;
}

const COLORS = ['#3b6bff', '#1fb567', '#f5a524', '#7c5cff', '#e5484d', '#0ea5e9'];
const REGISTRY = () => homePath('projects.json');

export function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
}

export class ProjectRegistry {
  private items: ProjectRecord[] = [];

  constructor() {
    this.items = readJsonFile<ProjectRecord[]>(REGISTRY(), []);
  }

  private save(): void {
    writeJsonFile(REGISTRY(), this.items);
  }

  list(): ProjectRecord[] {
    // Most-recently-opened first, then most-recently-created.
    return [...this.items].sort((a, b) => {
      const ao = a.lastOpenedAt ?? a.createdAt;
      const bo = b.lastOpenedAt ?? b.createdAt;
      return bo.localeCompare(ao);
    });
  }

  get(id: string): ProjectRecord | undefined {
    return this.items.find((p) => p.id === id);
  }

  private uniqueId(base: string): string {
    let id = slug(base);
    let n = 1;
    while (this.items.some((p) => p.id === id)) id = `${slug(base)}-${++n}`;
    return id;
  }

  /**
   * Add a real, existing folder as a project. Rejects paths that do not
   * exist or are not directories — never fabricates a project.
   */
  add(input: { name?: string; path: string; type?: string; language?: string; icon?: string }): ProjectRecord {
    const abs = path.resolve(input.path);
    const stat = fs.existsSync(abs) ? fs.statSync(abs) : null;
    if (!stat || !stat.isDirectory()) {
      throw new Error(`not a directory: ${abs}`);
    }
    if (this.items.some((p) => path.resolve(p.path) === abs)) {
      throw new Error(`project already added: ${abs}`);
    }
    const name = (input.name?.trim() || path.basename(abs)).slice(0, 80);
    const record: ProjectRecord = {
      id: this.uniqueId(name),
      name,
      path: abs,
      type: input.type ?? 'unknown',
      language: input.language ?? 'unknown',
      icon: input.icon ?? 'folder',
      color: COLORS[this.items.length % COLORS.length],
      favorite: false,
      createdAt: new Date().toISOString(),
      lastOpenedAt: null,
    };
    this.items.push(record);
    this.save();
    return record;
  }

  update(id: string, patch: Partial<Pick<ProjectRecord, 'name' | 'favorite' | 'type' | 'language' | 'icon' | 'color'>>): ProjectRecord {
    const p = this.get(id);
    if (!p) throw new Error(`no such project: ${id}`);
    if (patch.name !== undefined) p.name = patch.name.trim().slice(0, 80) || p.name;
    if (patch.favorite !== undefined) p.favorite = patch.favorite;
    if (patch.type !== undefined) p.type = patch.type;
    if (patch.language !== undefined) p.language = patch.language;
    if (patch.icon !== undefined) p.icon = patch.icon;
    if (patch.color !== undefined) p.color = patch.color;
    this.save();
    return p;
  }

  touch(id: string): ProjectRecord | undefined {
    const p = this.get(id);
    if (!p) return undefined;
    p.lastOpenedAt = new Date().toISOString();
    this.save();
    return p;
  }

  /** Remove a project from the registry. Never deletes the folder itself. */
  remove(id: string): boolean {
    const before = this.items.length;
    this.items = this.items.filter((p) => p.id !== id);
    if (this.items.length !== before) {
      this.save();
      return true;
    }
    return false;
  }
}
