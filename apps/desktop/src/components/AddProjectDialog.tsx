import { useState } from 'react';
import { Button, Dialog, Icon, Input, useToast } from '@aura/ui';
import { findAddedProject } from '../data/addedProject';
import { useAppStore } from '@aura/core';
import { useWorkspace } from '../data/useWorkspace';

/**
 * AddProjectDialog — import a real folder as a project.
 * ==================================================================
 * The backend only accepts a real, existing directory on disk, so this
 * takes an absolute path (in a packaged Tauri build a native folder
 * picker fills the same field). On success the folder is profiled and
 * added to the persistent registry — no sample project is ever created.
 */
export function AddProjectDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const addProject = useWorkspace((s) => s.addProject);
  const open_ = useWorkspace((s) => s.open);
  const { push } = useToast();
  const [path, setPath] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => { setPath(''); setName(''); setError(null); setBusy(false); };
  const close = () => { reset(); onClose(); };

  const submit = async () => {
    if (!path.trim()) { setError('Enter the folder path of a real project.'); return; }
    setBusy(true);
    setError(null);
    const res = await addProject(path.trim(), name.trim() || undefined);
    setBusy(false);
    if (!res.ok) { setError(res.error ?? 'Could not add project'); return; }
    push({ title: 'Project added', description: 'Indexing started automatically.', tone: 'positive' });
    // The folder just added becomes the active project: that is the
    // authority every workspace reads. Opening its service mount alone left
    // the active project unset, so the next mission had no folder to run in.
    const added = findAddedProject(useWorkspace.getState().projects, path);
    if (added) {
      useAppStore.getState().setActiveProject(added.id);
      void open_(added.id);
    }
    close();
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      title="Add a project"
      description="Import an existing folder. AURA profiles and indexes it — nothing is copied or modified."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={close}>Cancel</Button>
          <Button variant="primary" icon="plus" onClick={submit} disabled={busy}>{busy ? 'Adding…' : 'Add project'}</Button>
        </div>
      }
    >
      <div className="space-y-4">
        <label className="block">
          <span className="mb-1.5 block text-[12px] font-medium text-text-muted">Project folder (absolute path)</span>
          <Input icon="folder" placeholder="/path/to/your/project" value={path} onChange={(e) => setPath(e.target.value)} autoFocus />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-[12px] font-medium text-text-muted">Display name <span className="text-text-subtle">(optional)</span></span>
          <Input icon="note" placeholder="Defaults to the folder name" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
        </label>
        {error && (
          <div className="flex items-start gap-2 rounded-xl border border-critical/30 bg-critical/10 px-3 py-2.5 text-[12px] text-critical">
            <Icon name="close" size={14} className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}
        <p className="text-[11.5px] leading-relaxed text-text-subtle">
          The folder is analyzed locally: languages, frameworks, dependencies and system graph. Your code never leaves your machine.
        </p>
      </div>
    </Dialog>
  );
}
