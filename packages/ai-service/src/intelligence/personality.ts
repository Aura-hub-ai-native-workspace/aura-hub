/**
 * Repository Personality
 * ==================================================================
 * Defines the "personality" of a repository based on its characteristics:
 * - Communication style (formal, casual, technical)
 * - Code style preferences
 * - Documentation tone
 * - Response patterns
 */

import fs from 'node:fs';
import path from 'node:path';
import { homePath, readJsonFile, writeJsonFile } from '../persist';
import { IGNORE_DIRS } from './constants';
import type { ProjectIdentity, RepositoryProfile, ProjectGlossary } from './types';

const PERSONALITY_FILE = (projectId: string) => homePath('personality', `${projectId}.json`);

export type CommunicationStyle = 'formal' | 'casual' | 'technical' | 'academic' | 'mixed';
export type CodeStyle = 'minimal' | 'verbose' | 'functional' | 'object-oriented' | 'mixed';
export type DocumentationTone = 'concise' | 'detailed' | 'tutorial' | 'reference' | 'mixed';

export interface RepositoryPersonality {
  projectId: string;
  communicationStyle: CommunicationStyle;
  codeStyle: CodeStyle;
  documentationTone: DocumentationTone;
  technicalLevel: 'beginner' | 'intermediate' | 'advanced' | 'expert';
  responsePatterns: {
    verbosity: 'minimal' | 'moderate' | 'detailed';
    useExamples: boolean;
    includeReferences: boolean;
  };
  generatedAt: string;
}

/**
 * Load repository personality.
 */
export function loadPersonality(projectId: string): RepositoryPersonality | null {
  return readJsonFile<RepositoryPersonality | null>(PERSONALITY_FILE(projectId), null);
}

/**
 * Save repository personality.
 */
export function savePersonality(personality: RepositoryPersonality): void {
  writeJsonFile(PERSONALITY_FILE(personality.projectId), personality);
}

/**
 * Detect repository personality from code and documentation patterns.
 */
export function detectPersonality(
  projectId: string,
  root: string,
  identity: ProjectIdentity | null,
  _profile: RepositoryProfile | null,
  glossary: ProjectGlossary | null,
): RepositoryPersonality {
  const communicationStyle = detectCommunicationStyle(root);
  const codeStyle = detectCodeStyle(root);
  const documentationTone = detectDocumentationTone(root);
  const technicalLevel = detectTechnicalLevel(glossary, identity);
  const responsePatterns = detectResponsePatterns(root, identity);

  const personality: RepositoryPersonality = {
    projectId,
    communicationStyle,
    codeStyle,
    documentationTone,
    technicalLevel,
    responsePatterns,
    generatedAt: new Date().toISOString(),
  };

  savePersonality(personality);
  return personality;
}

/**
 * Detect communication style from README and documentation.
 */
function detectCommunicationStyle(root: string): CommunicationStyle {
  const readmeContent = readTextFile(path.join(root, 'README.md'))
    ?? readTextFile(path.join(root, 'readme.md'))
    ?? '';

  const formalIndicators = ['shall', 'therefore', 'consequently', 'furthermore', 'moreover'];
  const casualIndicators = ['hey', 'guys', 'cool', 'awesome', 'check out'];
  const technicalIndicators = ['implementation', 'architecture', 'abstraction', 'interface', 'protocol'];
  const academicIndicators = ['hypothesis', 'methodology', 'analysis', 'conclusion', 'abstract'];

  const contentLower = readmeContent.toLowerCase();

  const formalScore = formalIndicators.filter(i => contentLower.includes(i)).length;
  const casualScore = casualIndicators.filter(i => contentLower.includes(i)).length;
  const technicalScore = technicalIndicators.filter(i => contentLower.includes(i)).length;
  const academicScore = academicIndicators.filter(i => contentLower.includes(i)).length;

  const maxScore = Math.max(formalScore, casualScore, technicalScore, academicScore);

  if (maxScore === 0) return 'mixed';
  if (formalScore === maxScore) return 'formal';
  if (casualScore === maxScore) return 'casual';
  if (technicalScore === maxScore) return 'technical';
  return 'academic';
}

/**
 * Detect code style from source files.
 */
function detectCodeStyle(root: string): CodeStyle {
  let minimalCount = 0;
  let verboseCount = 0;
  let functionalCount = 0;
  let ooCount = 0;

  const scanFile = (filePath: string) => {
    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch {
      return;
    }

    // Check for functional patterns
    if (content.includes('=>') && !content.includes('class ')) functionalCount++;
    if (content.includes('.map(') && content.includes('.filter(')) functionalCount++;

    // Check for OOP patterns
    if (content.includes('class ') && content.includes('extends')) ooCount++;
    if (content.includes('interface ') && content.includes('implements')) ooCount++;

    // Check for minimal style (short files, few comments)
    const lines = content.split('\n').length;
    const comments = content.split('\n').filter(l => l.trim().startsWith('//')).length;
    if (lines < 50 && comments < 5) minimalCount++;
    if (lines > 100 && comments > 10) verboseCount++;
  };

  const scanDir = (dir: string, depth: number = 0) => {
    if (depth > 3) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const e of entries) {
      if (e.name.startsWith('.') || IGNORE_DIRS.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        scanDir(full, depth + 1);
      } else {
        const ext = path.extname(e.name).toLowerCase();
        if (['.ts', '.js', '.py'].includes(ext)) {
          scanFile(full);
        }
      }
    }
  };

  scanDir(root);

  const maxScore = Math.max(minimalCount, verboseCount, functionalCount, ooCount);
  if (maxScore === 0) return 'mixed';
  if (functionalCount === maxScore) return 'functional';
  if (ooCount === maxScore) return 'object-oriented';
  if (minimalCount === maxScore) return 'minimal';
  return 'verbose';
}

/**
 * Detect documentation tone from docs and comments.
 */
function detectDocumentationTone(root: string): DocumentationTone {
  const docsDir = path.join(root, 'docs');
  let docContent = '';

  if (fs.existsSync(docsDir)) {
    try {
      const files = fs.readdirSync(docsDir).filter(f => f.endsWith('.md'));
      for (const f of files.slice(0, 5)) {
        docContent += readTextFile(path.join(docsDir, f)) ?? '';
      }
    } catch { /* ignore */ }
  }

  if (!docContent) return 'mixed';

  const conciseIndicators = ['brief', 'quick', 'short', 'summary'];
  const detailedIndicators = ['comprehensive', 'detailed', 'in-depth', 'thorough'];
  const tutorialIndicators = ['step', 'tutorial', 'guide', 'how to', 'getting started'];
  const referenceIndicators = ['api', 'reference', 'documentation', 'specification'];

  const contentLower = docContent.toLowerCase();

  const conciseScore = conciseIndicators.filter(i => contentLower.includes(i)).length;
  const detailedScore = detailedIndicators.filter(i => contentLower.includes(i)).length;
  const tutorialScore = tutorialIndicators.filter(i => contentLower.includes(i)).length;
  const referenceScore = referenceIndicators.filter(i => contentLower.includes(i)).length;

  const maxScore = Math.max(conciseScore, detailedScore, tutorialScore, referenceScore);

  if (maxScore === 0) return 'mixed';
  if (conciseScore === maxScore) return 'concise';
  if (detailedScore === maxScore) return 'detailed';
  if (tutorialScore === maxScore) return 'tutorial';
  return 'reference';
}

/**
 * Detect technical level based on glossary and identity.
 */
function detectTechnicalLevel(
  glossary: ProjectGlossary | null,
  _identity: ProjectIdentity | null,
): RepositoryPersonality['technicalLevel'] {
  if (!glossary) return 'intermediate';

  const termCount = Object.keys(glossary.entries).length;
  const advancedTerms = Object.values(glossary.entries).filter(e =>
    e.definition.toLowerCase().includes('advanced') ||
    e.definition.toLowerCase().includes('complex')
  ).length;

  if (termCount > 50 && advancedTerms > 10) return 'expert';
  if (termCount > 20 && advancedTerms > 5) return 'advanced';
  if (termCount < 10) return 'beginner';
  return 'intermediate';
}

/**
 * Detect response patterns from code and documentation.
 */
function detectResponsePatterns(
  root: string,
  _identity: ProjectIdentity | null,
): RepositoryPersonality['responsePatterns'] {
  let verbosity: 'minimal' | 'moderate' | 'detailed' = 'moderate';
  let useExamples = false;
  let includeReferences = false;

  // Check for examples directory
  const examplesDir = path.join(root, 'examples');
  if (fs.existsSync(examplesDir)) {
    useExamples = true;
  }

  // Check for references in docs
  const docsDir = path.join(root, 'docs');
  if (fs.existsSync(docsDir)) {
    try {
      const files = fs.readdirSync(docsDir);
      if (files.some(f => f.includes('reference') || f.includes('api'))) {
        includeReferences = true;
      }
    } catch { /* ignore */ }
  }

  // Determine verbosity from README length
  const readmeContent = readTextFile(path.join(root, 'README.md'))
    ?? readTextFile(path.join(root, 'readme.md'))
    ?? '';
  const readmeLines = readmeContent.split('\n').length;

  if (readmeLines < 30) verbosity = 'minimal';
  else if (readmeLines > 100) verbosity = 'detailed';
  else verbosity = 'moderate';

  return { verbosity, useExamples, includeReferences };
}

/**
 * Helper to read text file.
 */
function readTextFile(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}
