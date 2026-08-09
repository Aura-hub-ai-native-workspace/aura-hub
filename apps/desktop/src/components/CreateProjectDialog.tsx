import { useState } from 'react';
import { Button, Dialog, Icon, Input, useToast } from '@aura/ui';
import { useWorkspace } from '../data/useWorkspace';

/**
 * CreateProjectDialog — frontend-only "Create Project" flow.
 * ==================================================================
 * A real project needs the backend to scaffold a folder and profile it,
 * which is out of scope here. This flow is deliberately frontend-only:
 * it validates the input and records the new project in the session's
 * project list (the existing useWorkspace store). Registering a real
 * folder — profiling, indexing, persistence — still happens through the
 * existing "Add Project" flow, which is unchanged.
 */
export function CreateProjectDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const createLocalProject = useWorkspace((s) => s.createLocalProject);
  const { push } = useToast();
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState(false);

  const reset = () => { setName(''); setPath(''); setError(null); setBusy(false); setCreated(false); };
  const close = () => { reset(); onClose(); };

  const validate = (): string | null => {
    const n = name.trim();
    if (!n) return 'Enter a project name.';
    if (n.length > 80) return 'Keep the project name under 80 characters.';
    if (/[<>:"/\\|?*]/.test(n)) return 'Project names cannot contain < > : " / \\ | ? * characters.';
    if (/^[.\s]|[.\s]$/.test(n)) return 'Project names cannot start or end with a dot or space.';
    if (!path.trim()) return 'Enter the folder where the project should live.';
    return null;
  };

  const submit = async () => {
    const invalid = validate();
    if (invalid) { setError(invalid); return; }
    setBusy(true);
    setError(null);
    try {
      // Frontend-only creation — a short pause surfaces the loading state.
      await new Promise((r) => setTimeout(r, 450));
      createLocalProject(name.trim(), path.trim());
      setCreated(true);
      push({ title: 'Project created', description: `${name.trim()} was added to your project list for this session.`, tone: 'positive' });
      setTimeout(close, 700);
    } catch (e) {
      setError((e as Error).message || 'Could not create the project.');
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      title="Create Project"
      description="Scaffold a brand-new project into the environment."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={close}>Cancel</Button>
          <Button
            variant="primary"
            icon="spark"
            onClick={submit}
            disabled={busy}
            className="bg-[#00b3ff] shadow-[0_0_16px_rgba(0,179,255,0.45)] hover:bg-[#2fc2ff] hover:shadow-[0_0_26px_rgba(0,179,255,0.65)] active:bg-[#0093d4] focus-visible:ring-cyan-300/60"
          >
            {busy ? 'Creating…' : 'Create Project'}
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <label className="block">
          <span className="mb-1.5 block text-[12px] font-medium text-text-muted">Project name</span>
          <Input icon="note" placeholder="My new project" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-[12px] font-medium text-text-muted">Project location / folder (absolute path)</span>
          <Input icon="folder" placeholder="/path/to/project-location" value={path} onChange={(e) => setPath(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
        </label>
        {error && (
          <div className="flex items-start gap-2 rounded-xl border border-critical/30 bg-critical/10 px-3 py-2.5 text-[12px] text-critical">
            <Icon name="close" size={14} className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}
        {created && (
          <div className="flex items-start gap-2 rounded-xl border border-positive/30 bg-positive/10 px-3 py-2.5 text-[12px] text-positive">
            <Icon name="spark" size={14} className="mt-0.5 shrink-0" />
            <span>Project created and added to your list.</span>
          </div>
        )}
        <p className="text-[11.5px] leading-relaxed text-text-subtle">
          This is a frontend-only creation — the project is added to your list for this session.
          To register a real folder (profiling and indexing), use <span className="font-medium text-text-muted">Add Project</span>.
        </p>
      </div>
    </Dialog>
  );
}
