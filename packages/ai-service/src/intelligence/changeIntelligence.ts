/**
 * Change Intelligence
 * ==================================================================
 * Tracks and analyzes changes in the repository:
 * - Change patterns and frequency
 * - Impact analysis
 * - Change velocity
 * - Hotspot detection
 */

import { homePath, readJsonFile, writeJsonFile } from '../persist';

const CHANGE_LOG_FILE = homePath('changes', 'log.json');

export interface ChangeEntry {
  file: string;
  timestamp: string;
  type: 'create' | 'modify' | 'delete' | 'rename';
  size?: number;
  linesAdded?: number;
  linesRemoved?: number;
}

export interface ChangePattern {
  pattern: string;
  frequency: number;
  files: string[];
  lastOccurrence: string;
}

export interface ChangeImpact {
  file: string;
  impactScore: number; // 0-100
  dependents: number;
  recentChanges: number;
}

export interface ChangeLog {
  entries: ChangeEntry[];
  patterns: ChangePattern[];
  generatedAt: string;
}

/**
 * Load the change log.
 */
export function loadChangeLog(): ChangeLog | null {
  return readJsonFile<ChangeLog | null>(CHANGE_LOG_FILE, null);
}

/**
 * Save the change log.
 */
export function saveChangeLog(log: ChangeLog): void {
  writeJsonFile(CHANGE_LOG_FILE, log);
}

/**
 * Record a file change.
 */
export function recordChange(
  file: string,
  type: ChangeEntry['type'],
  linesAdded?: number,
  linesRemoved?: number,
): void {
  const log = loadChangeLog() ?? { entries: [], patterns: [], generatedAt: new Date().toISOString() };

  log.entries.push({
    file,
    timestamp: new Date().toISOString(),
    type,
    linesAdded,
    linesRemoved,
  });

  // Keep last 1000 entries
  if (log.entries.length > 1000) {
    log.entries = log.entries.slice(-1000);
  }

  log.generatedAt = new Date().toISOString();
  saveChangeLog(log);
}

/**
 * Analyze change patterns.
 */
export function analyzeChangePatterns(log: ChangeLog): ChangePattern[] {
  const fileChanges = new Map<string, number[]>();

  for (const entry of log.entries) {
    const existing = fileChanges.get(entry.file) ?? [];
    existing.push(new Date(entry.timestamp).getTime());
    fileChanges.set(entry.file, existing);
  }

  const patterns: ChangePattern[] = [];

  // Detect frequently changed files
  for (const [file, timestamps] of fileChanges) {
    if (timestamps.length >= 3) {
      const recentChanges = timestamps.filter(t => t > Date.now() - 7 * 24 * 60 * 60 * 1000);
      if (recentChanges.length >= 2) {
        patterns.push({
          pattern: 'frequently_changed',
          frequency: timestamps.length,
          files: [file],
          lastOccurrence: new Date(Math.max(...timestamps)).toISOString(),
        });
      }
    }
  }

  // Detect change bursts (many changes in short time)
  const sortedEntries = [...log.entries].sort((a, b) =>
    new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );

  for (let i = 0; i < sortedEntries.length - 5; i++) {
    const window = sortedEntries.slice(i, i + 5);
    const timeSpan = new Date(window[4].timestamp).getTime() - new Date(window[0].timestamp).getTime();
    if (timeSpan < 60 * 60 * 1000) { // 5 changes within 1 hour
      patterns.push({
        pattern: 'change_burst',
        frequency: 5,
        files: window.map(e => e.file),
        lastOccurrence: window[4].timestamp,
      });
    }
  }

  return patterns;
}

/**
 * Calculate change impact for each file.
 */
export function calculateChangeImpact(log: ChangeLog): ChangeImpact[] {
  const fileStats = new Map<string, { changes: number; lastChange: string }>();

  for (const entry of log.entries) {
    const existing = fileStats.get(entry.file) ?? { changes: 0, lastChange: entry.timestamp };
    existing.changes++;
    if (entry.timestamp > existing.lastChange) {
      existing.lastChange = entry.timestamp;
    }
    fileStats.set(entry.file, existing);
  }

  const impacts: ChangeImpact[] = [];

  for (const [file, stats] of fileStats) {
    const impactScore = Math.min(100, stats.changes * 10);
    impacts.push({
      file,
      impactScore,
      dependents: 0, // Would need dependency graph
      recentChanges: stats.changes,
    });
  }

  return impacts.sort((a, b) => b.impactScore - a.impactScore);
}

/**
 * Get change velocity (changes per day).
 */
export function getChangeVelocity(log: ChangeLog, days: number = 7): number {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const recentChanges = log.entries.filter(e => new Date(e.timestamp).getTime() > cutoff);
  return recentChanges.length / days;
}

/**
 * Detect hotspots (files with high change frequency and impact).
 */
export function detectHotspots(log: ChangeLog): { file: string; score: number; reason: string }[] {
  const impacts = calculateChangeImpact(log);
  const hotspots: { file: string; score: number; reason: string }[] = [];

  for (const impact of impacts.slice(0, 10)) {
    if (impact.impactScore >= 50) {
      hotspots.push({
        file: impact.file,
        score: impact.impactScore,
        reason: `Changed ${impact.recentChanges} times`,
      });
    }
  }

  return hotspots;
}

/**
 * Generate change report summary.
 */
export function generateChangeReport(log: ChangeLog): string {
  const velocity = getChangeVelocity(log);
  const patterns = analyzeChangePatterns(log);
  const hotspots = detectHotspots(log);

  const lines = [
    `Change Velocity: ${velocity.toFixed(1)} changes/day`,
    `Total Changes: ${log.entries.length}`,
    `Patterns Detected: ${patterns.length}`,
    `Hotspots: ${hotspots.length}`,
  ];

  if (hotspots.length > 0) {
    lines.push('\nHotspot Files:');
    for (const h of hotspots.slice(0, 5)) {
      lines.push(`  - ${h.file} (score: ${h.score})`);
    }
  }

  return lines.join('\n');
}
