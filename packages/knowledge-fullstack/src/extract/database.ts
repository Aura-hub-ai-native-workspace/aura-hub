/**
 * DatabaseExtractor — tables, ORM models, columns, foreign keys,
 * indexes and migrations from real SQL, TypeORM, Prisma, Sequelize
 * and Mongoose sources.
 */

import { makeEntity, snippetAround, type Extractor, type LineMap, type SourceFile } from './extractor';
import type { Entity } from '../types';

const isSql = (f: SourceFile) => f.language === 'sql' || f.ext === '.sql';
const isPrisma = (f: SourceFile) => f.name.toLowerCase().endsWith('.prisma');
const isTsOrm = (f: SourceFile) =>
  ['typescript', 'javascript'].includes(f.language) &&
  /@Entity|@Column|@PrimaryColumn|@PrimaryGeneratedColumn|sequelize\.define|new\s+Schema|mongoose\.model|extends\s+Model/.test(f.text);

export class DatabaseExtractor implements Extractor {
  readonly id = 'database';
  appliesTo(f: SourceFile): boolean {
    return isSql(f) || isPrisma(f) || isTsOrm(f) || /(?:^|\/)migrations?\//i.test(f.relPath);
  }

  extract(f: SourceFile, lines: LineMap): Entity[] {
    if (isSql(f)) return this.sql(f, lines);
    if (isPrisma(f)) return this.prisma(f, lines);
    return this.tsOrm(f, lines);
  }

  /* ── SQL migrations / DDL ────────────────────────────────────────── */
  private sql(f: SourceFile, lines: LineMap): Entity[] {
    const text = f.text;
    const entities: Entity[] = [];
    const tables = new Set<string>();
    let m: RegExpExecArray | null;

    const createRe = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`]?([A-Za-z0-9_.]+)["'`]?\s*\(([\s\S]*?)\);/gi;
    while ((m = createRe.exec(text))) {
      const table = m[1].replace(/^.*\./, '');
      tables.add(table);
      const body = m[2];
      const columns = [...body.matchAll(/^\s*["'`]?([A-Za-z0-9_]+)["'`]?\s+[A-Za-z]/gm)].map((c) => c[1]).filter((c) => !/^(primary|foreign|constraint|unique|index|key|check)$/i.test(c));
      const foreignKeys = [...body.matchAll(/FOREIGN\s+KEY\s*\(\s*["'`]?([A-Za-z0-9_]+)["'`]?\s*\)\s*REFERENCES\s+["'`]?([A-Za-z0-9_.]+)/gi)].map((fk) => ({ column: fk[1], refTable: fk[2].replace(/^.*\./, '') }));
      const line = lines.lineAt(m.index);
      entities.push(makeEntity({ kind: 'table', layer: 'database', name: table, file: f, line, summary: `Table ${table} (${columns.length} cols)`, snippet: snippetAround(f, line, 6), metadata: { columns, foreignKeys, indexes: [] } }));
    }
    for (const idx of text.matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+["'`]?([A-Za-z0-9_]+)["'`]?\s+ON\s+["'`]?([A-Za-z0-9_.]+)/gi)) {
      const table = idx[2].replace(/^.*\./, '');
      const existing = entities.find((e) => e.kind === 'table' && e.name === table);
      if (existing) (existing.metadata.indexes as string[]).push(idx[1]);
    }

    const migName = f.name.replace(/\.sql$/i, '');
    entities.push(makeEntity({ kind: 'migration', layer: 'database', name: migName, file: f, line: 1, summary: `Migration ${migName}`, metadata: { tables: [...tables] } }));
    return entities;
  }

  /* ── Prisma schema ───────────────────────────────────────────────── */
  private prisma(f: SourceFile, lines: LineMap): Entity[] {
    const entities: Entity[] = [];
    for (const m of f.text.matchAll(/model\s+([A-Za-z0-9_]+)\s*\{([\s\S]*?)\}/g)) {
      const name = m[1];
      const body = m[2];
      const columns = [...body.matchAll(/^\s*([A-Za-z0-9_]+)\s+([A-Za-z0-9_\[\]?]+)/gm)].map((c) => c[1]);
      const relations = [...body.matchAll(/^\s*[A-Za-z0-9_]+\s+([A-Z][A-Za-z0-9_]*)(\[\])?\s/gm)].map((r) => r[1]);
      const mapped = /@@map\(\s*"([^"]+)"/.exec(body)?.[1] ?? name;
      const line = lines.lineAt(m.index ?? 0);
      entities.push(makeEntity({ kind: 'orm-model', layer: 'database', name, file: f, line, summary: `Prisma model ${name}`, snippet: snippetAround(f, line, 6), metadata: { tableName: mapped, columns, relations: [...new Set(relations)] } }));
      entities.push(makeEntity({ kind: 'table', layer: 'database', name: mapped, file: f, line, summary: `Table ${mapped}`, metadata: { columns, foreignKeys: [], indexes: [] } }));
    }
    return entities;
  }

  /* ── TypeORM / Sequelize / Mongoose ──────────────────────────────── */
  private tsOrm(f: SourceFile, lines: LineMap): Entity[] {
    const text = f.text;
    const entities: Entity[] = [];
    let m: RegExpExecArray | null;

    // TypeORM: @Entity('table') class Name { @Column ... @ManyToOne(()=>Other) }
    const entRe = /@Entity\s*\(\s*(?:[`'"]([^`'"]+)[`'"])?\s*\)\s*(?:export\s+)?class\s+([A-Za-z0-9_]+)/g;
    while ((m = entRe.exec(text))) {
      const tableName = m[1] ?? m[2].toLowerCase();
      const cname = m[2];
      const body = text.slice(m.index, m.index + 2000);
      const columns = [...body.matchAll(/@(?:Column|PrimaryColumn|PrimaryGeneratedColumn|CreateDateColumn)\s*\([^)]*\)\s*([A-Za-z0-9_]+)/g)].map((c) => c[1]);
      const relations = [...body.matchAll(/@(?:ManyToOne|OneToMany|OneToOne|ManyToMany)\s*\(\s*\(\)\s*=>\s*([A-Za-z0-9_]+)/g)].map((r) => r[1]);
      const line = lines.lineAt(m.index);
      entities.push(makeEntity({ kind: 'orm-model', layer: 'database', name: cname, file: f, line, summary: `ORM model ${cname}`, snippet: snippetAround(f, line, 4), metadata: { tableName, columns, relations: [...new Set(relations)] } }));
      entities.push(makeEntity({ kind: 'table', layer: 'database', name: tableName, file: f, line, summary: `Table ${tableName}`, metadata: { columns, foreignKeys: [], indexes: [] } }));
    }

    // Sequelize: X.init / sequelize.define('name', {...})
    for (const s of text.matchAll(/sequelize\.define\s*\(\s*[`'"]([^`'"]+)[`'"]/g)) {
      const line = lines.lineAt(s.index ?? 0);
      entities.push(makeEntity({ kind: 'orm-model', layer: 'database', name: s[1], file: f, line, summary: `Sequelize model ${s[1]}`, metadata: { tableName: s[1] } }));
      entities.push(makeEntity({ kind: 'table', layer: 'database', name: s[1], file: f, line, summary: `Table ${s[1]}`, metadata: { columns: [], foreignKeys: [], indexes: [] } }));
    }

    // Mongoose: mongoose.model('Name', schema)
    for (const s of text.matchAll(/mongoose\.model\s*\(\s*[`'"]([^`'"]+)[`'"]/g)) {
      const line = lines.lineAt(s.index ?? 0);
      entities.push(makeEntity({ kind: 'orm-model', layer: 'database', name: s[1], file: f, line, summary: `Mongoose model ${s[1]}`, metadata: { tableName: s[1].toLowerCase() } }));
    }

    return entities;
  }
}
