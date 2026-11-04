/**
 * NewProjectDialog — turn a developed idea into a real project.
 * ------------------------------------------------------------------
 * The person names it and confirms; nothing is created before that. The
 * service creates the folder (its name derived from the project name, never
 * taken from it; an existing folder is never reused) and registers it, then
 * the conversation that produced the idea is carried into the new project's
 * shared context. If carrying the context over fails the project still exists
 * — the dialog says so and offers to retry that step instead of pretending
 * nothing happened or leaving the person guessing.
 */
import { useEffect, useState } from 'react';
import { Button, Dialog, Icon, Input } from '@aura/ui';
import { aiClient } from '../ai/aiClient';
import { centralAgentClient } from '../ai/centralAgentClient';

export interface ProjectLocation { parent: string; dirName: string; target: string; overridden: boolean; renamed: boolean }

/**
 * What the dialog says about where the project will go. Only the service knows
 * (it applies AURA_PROJECTS_DIR and the next-free-name rule), so this never
 * guesses a path: with no answer yet it says so instead of showing a default.
 */
export function describeLocation(loc: ProjectLocation | null, failed = false): string {
  if (failed) return 'The folder location could not be worked out. It is shown here once the name is valid.';
  if (!loc) return 'Working out where the folder will go…';
  return `Creates ${loc.target}.`
    + (loc.renamed ? ' A folder with that name already exists, so a number was added.' : '')
    + (loc.overridden ? ' (Projects folder set by AURA_PROJECTS_DIR.)' : '')
    + ' An existing folder is never reused or changed.';
}

export function validateProjectName(name: string): string | null {
  const n = name.trim();
  if (!n) return 'Give the project a name.';
  if (n.length > 80) return 'Keep the name under 80 characters.';
  if (/[/\\]/.test(n) || n === '.' || n === '..') return 'The name cannot contain slashes or be "." or "..".';
  if (!/[a-z0-9]/i.test(n)) return 'Use at least one letter or number.';
  return null;
}

type Step = 'name' | 'creating' | 'adopt-failed';

export function NewProjectDialog({ open, onClose, sessionId, idea, suggestedName, onCreated }: {
  open: boolean;
  onClose: () => void;
  /** The general-chat conversation that produced the idea. */
  sessionId: string | null;
  idea: string;
  suggestedName?: string;
  /** Called once the project exists and the idea has been carried over. */
  onCreated: (projectId: string) => void;
}) {
  const [name, setName] = useState(suggestedName ?? '');
  const [step, setStep] = useState<Step>('name');
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ id: string; path: string } | null>(null);
  const [location, setLocation] = useState<{ loc: ProjectLocation | null; failed: boolean }>({ loc: null, failed: false });
  // The preview is the service's answer for THIS name, the same function creation uses.
  useEffect(() => {
    if (validateProjectName(name)) { setLocation({ loc: null, failed: true }); return; }
    setLocation({ loc: null, failed: false });
    let live = true;
    const t = setTimeout(() => {
      aiClient.projectLocation(name.trim())
        .then((loc) => { if (live) setLocation({ loc, failed: false }); })
        .catch(() => { if (live) setLocation({ loc: null, failed: true }); });
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [name]);

  const reset = () => { setStep('name'); setError(null); setCreated(null); };
  const close = () => { if (step !== 'creating') { reset(); onClose(); } };

  const adopt = async (projectId: string): Promise<boolean> => {
    if (!sessionId) return true; // nothing to carry over
    try {
      await centralAgentClient.adoptConversation(projectId, sessionId, idea);
      return true;
    } catch (e) {
      setError((e as Error).message || 'The conversation could not be carried into the project.');
      return false;
    }
  };

  const submit = async () => {
    const invalid = validateProjectName(name);
    if (invalid) { setError(invalid); return; }
    setError(null);
    setStep('creating');
    try {
      const res = await aiClient.createProject(name.trim());
      if ('error' in res) { setError(res.error); setStep('name'); return; }
      setCreated({ id: res.project.id, path: res.project.path });
      if (await adopt(res.project.id)) { reset(); onCreated(res.project.id); } else setStep('adopt-failed');
    } catch (e) {
      setError((e as Error).message || 'The project could not be created.');
      setStep('name');
    }
  };

  const retryAdopt = async () => {
    if (!created) return;
    setError(null);
    setStep('creating');
    if (await adopt(created.id)) { reset(); onCreated(created.id); } else setStep('adopt-failed');
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      title="Create New Project"
      description="Your idea, the decisions you reached and the research behind them come with it."
      footer={
        step === 'adopt-failed' ? (
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => { const id = created?.id; reset(); if (id) onCreated(id); }}>Continue without it</Button>
            <Button variant="primary" onClick={() => void retryAdopt()}>Try again</Button>
          </div>
        ) : (
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={close} disabled={step === 'creating'}>Cancel</Button>
            <Button variant="primary" icon="folder" loading={step === 'creating'} disabled={step === 'creating'} onClick={() => void submit()}>
              Create project
            </Button>
          </div>
        )
      }
    >
      {step === 'adopt-failed' ? (
        <div className="space-y-3 text-[12.5px]">
          <div className="rounded-xl border border-positive/30 bg-positive/10 px-3 py-2.5 text-positive">
            The project folder was created at <span className="font-mono">{created?.path}</span>.
          </div>
          <div className="rounded-xl border border-critical/30 bg-critical/10 px-3 py-2.5 text-critical">
            But your conversation could not be carried into it: {error}
          </div>
          <p className="text-text-muted">You can try again, or open the project without that context and tell it the idea again.</p>
        </div>
      ) : (
        <div className="space-y-4">
          <label className="block">
            <span className="mb-1.5 block text-[12px] font-medium text-text-muted">Project name</span>
            <Input icon="note" placeholder="My new project" value={name} autoFocus
              onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void submit()} />
          </label>
          <p className="text-[11.5px] leading-relaxed text-text-subtle">
            <span data-testid="project-location" className="font-mono text-text-muted break-all">{describeLocation(location.loc, location.failed)}</span>
          </p>
          {idea && (
            <div className="rounded-xl border border-line bg-surface-hover/50 px-3 py-2.5 text-[12px] text-text-muted">
              <div className="mb-1 flex items-center gap-1.5 font-medium text-text"><Icon name="spark" size={12} className="text-accent" /> The idea</div>
              {idea.length > 220 ? `${idea.slice(0, 220)}…` : idea}
            </div>
          )}
          {error && (
            <div className="flex items-start gap-2 rounded-xl border border-critical/30 bg-critical/10 px-3 py-2.5 text-[12px] text-critical">
              <Icon name="close" size={14} className="mt-0.5 shrink-0" /><span>{error}</span>
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}
