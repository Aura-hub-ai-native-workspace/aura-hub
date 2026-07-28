import { useState } from 'react';
import { Badge, Button, Card, CardHeader, Icon, IconButton, Input } from '@aura/ui';
import { SectionView, Block, StatTile } from '../components/kit';
import { EmptyState } from '../../../components/EmptyState';
import { useProjectData } from './shared';
import { useWorkspace } from '../../../data/useWorkspace';
import type { MemoryKind } from '../../../ai/aiClient';

/**
 * Memory — the project's real, persistent memory. Items are authored by
 * the user (or captured from AI interactions), stored on disk, and fed
 * back into answers via the memory context provider. Survives restarts.
 */
const KINDS: MemoryKind[] = ['decision', 'correction', 'learning', 'pinned', 'code', 'accepted', 'rejected', 'conversation'];

function fmt(iso: string) {
  const d = Date.now() - new Date(iso).getTime();
  const m = Math.round(d / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

export function Memory({ projectId }: { projectId: string }) {
  const { memory } = useProjectData(projectId);
  const { addMemory, pinMemory, removeMemory } = useWorkspace();
  const [kind, setKind] = useState<MemoryKind>('decision');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');

  const submit = async () => {
    if (!title.trim()) return;
    await addMemory(projectId, { kind, title: title.trim(), body: body.trim(), pinned: kind === 'pinned' });
    setTitle(''); setBody('');
  };

  const pinned = memory.filter((m) => m.pinned).length;

  return (
    <SectionView title="Memory" hint="Persistent, project-scoped memory that influences AI answers.">
      <Block className="mb-5">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <StatTile icon="memory" label="Total items" value={memory.length} tone="info" />
          <StatTile icon="pin" label="Pinned" value={pinned} tone="attention" />
          <StatTile icon="check" label="Decisions" value={memory.filter((m) => m.kind === 'decision').length} tone="positive" />
          <StatTile icon="spark" label="Corrections" value={memory.filter((m) => m.kind === 'correction').length} />
        </div>
      </Block>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <Block className="lg:col-span-2">
          {memory.length === 0 ? (
            <Card><EmptyState icon="memory" title="No memory yet" description="Record a decision, correction or pinned fact. AURA will recall it in future answers." compact /></Card>
          ) : (
            <div className="space-y-3">
              {memory.map((m) => (
                <Card key={m.id} padding="md">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <Badge tone={m.pinned ? 'attention' : 'neutral'}>{m.kind}</Badge>
                        <span className="text-[11px] text-text-subtle">{fmt(m.at)}</span>
                      </div>
                      <div className="mt-1.5 text-[13.5px] font-medium text-text">{m.title}</div>
                      {m.body && <p className="mt-1 whitespace-pre-wrap text-[12.5px] leading-relaxed text-text-muted">{m.body}</p>}
                    </div>
                    <div className="flex shrink-0 items-center gap-0.5">
                      <IconButton icon="pin" label={m.pinned ? 'Unpin' : 'Pin'} className={m.pinned ? 'text-accent' : 'text-text-subtle'} onClick={() => void pinMemory(projectId, m.id, !m.pinned)} />
                      <IconButton icon="close" label="Delete" className="text-text-subtle" onClick={() => void removeMemory(projectId, m.id)} />
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </Block>

        <Block>
          <Card className="h-full">
            <CardHeader title="Add memory" />
            <div className="mt-4 space-y-3">
              <div className="flex flex-wrap gap-1.5">
                {KINDS.map((k) => (
                  <button key={k} onClick={() => setKind(k)} className={`rounded-lg px-2.5 py-1 text-[11.5px] font-medium capitalize transition-colors ${kind === k ? 'bg-accent text-white' : 'bg-surface-active text-text-muted hover:text-text'}`}>{k}</button>
                ))}
              </div>
              <Input placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} />
              <textarea
                placeholder="Details (optional)"
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={4}
                className="w-full resize-none rounded-xl border border-line bg-surface px-3 py-2 text-[12.5px] text-text outline-none placeholder:text-text-subtle focus:border-accent"
              />
              <Button icon="plus" onClick={submit} className="w-full justify-center" disabled={!title.trim()}>Remember this</Button>
              <p className="text-[11px] leading-relaxed text-text-subtle"><Icon name="cpu" size={11} className="mr-1 inline" />Stored on disk and recalled automatically when relevant to a question.</p>
            </div>
          </Card>
        </Block>
      </div>
    </SectionView>
  );
}
