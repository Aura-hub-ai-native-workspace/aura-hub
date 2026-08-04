import { useState } from 'react';
import { Button, Icon, Input } from '@aura/ui';
import { aiClient } from '../../ai/aiClient';
import { useWorkflows } from '../../data/useWorkflows';
import { AiMarkdown } from '../../ai/AiMarkdown';

/**
 * AiBuilderPanel — the AI Workflow Builder, the flagship creation mode.
 * ==================================================================
 * Permanently docked on the right of the editor (alongside, not replacing,
 * the per-node inspector — both are needed at once). Describe a workflow
 * in plain language; the backend (POST /workflows/generate) calls the
 * same generation seam every other AI feature uses, validates the result
 * against the real node registry, and saves it as a real workflow. The
 * graph then loads into the canvas immediately via the existing
 * `useWorkflows.open()` — every node is editable exactly as if it had
 * been built by hand with the Visual Builder.
 */
interface BuilderMessage {
  role: 'user' | 'assistant';
  text: string;
  tone?: 'error';
}

export function AiBuilderPanel() {
  const wf = useWorkflows();
  const [messages, setMessages] = useState<BuilderMessage[]>([]);
  const [input, setInput] = useState('');
  const [pending, setPending] = useState(false);

  const submit = async () => {
    const text = input.trim();
    if (!text || pending) return;
    setInput('');
    setMessages((m) => [...m, { role: 'user', text }]);
    setPending(true);
    try {
      if (wf.dirty) await wf.save();
      const result = await aiClient.generateWorkflow(text);
      if (!('id' in result)) {
        setMessages((m) => [...m, { role: 'assistant', text: `Couldn't build that: ${result.error}`, tone: 'error' }]);
        return;
      }
      setMessages((m) => [
        ...m,
        {
          role: 'assistant',
          text: `Built **${result.name}** — ${result.nodes.length} node${result.nodes.length === 1 ? '' : 's'}, ${result.edges.length} connection${result.edges.length === 1 ? '' : 's'}. Edit any node on the canvas, or ask for changes.`,
        },
      ]);
      await wf.open(result.id);
    } catch (e) {
      setMessages((m) => [...m, { role: 'assistant', text: `Couldn't reach the workflow builder: ${(e as Error).message}`, tone: 'error' }]);
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex w-[300px] shrink-0 flex-col border-l border-line">
      <div className="flex items-center gap-2 border-b border-line px-3.5 py-2.5">
        <Icon name="spark" size={14} className="text-accent" />
        <span className="text-[12.5px] font-semibold text-text">AI Workflow Builder</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3.5 py-3">
        {messages.length === 0 ? (
          <p className="text-[12px] leading-relaxed text-text-muted">
            Describe the workflow you want, in plain language — e.g. "Whenever a pull request is opened, search
            similar fixes, analyze architecture impact, and notify Slack." AURA builds the graph and drops it on the
            canvas, ready to edit.
          </p>
        ) : (
          <div className="space-y-3">
            {messages.map((m, i) => (
              <div
                key={i}
                className={
                  m.role === 'user'
                    ? 'ml-4 rounded-xl bg-surface-active px-3 py-2 text-[12px] text-text'
                    : `mr-2 rounded-xl border px-3 py-2 text-[12px] ${m.tone === 'error' ? 'border-danger/30 bg-danger/5 text-danger' : 'border-line bg-surface text-text'}`
                }
              >
                {m.role === 'assistant' ? <AiMarkdown source={m.text} /> : m.text}
              </div>
            ))}
          </div>
        )}
        {pending && (
          <div className="mr-2 mt-3 flex items-center gap-2 text-[11.5px] text-text-muted">
            <Icon name="spark" size={12} className="animate-pulse text-accent" /> Building the workflow…
          </div>
        )}
      </div>
      <div className="border-t border-line p-2.5">
        <div className="flex items-end gap-1.5">
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void submit();
              }
            }}
            placeholder="Describe a workflow…"
            className="flex-1"
          />
          <Button size="sm" icon="spark" onClick={() => void submit()} disabled={pending || !input.trim()}>
            Build
          </Button>
        </div>
      </div>
    </div>
  );
}
