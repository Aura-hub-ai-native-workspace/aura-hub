/**
 * ConversationInspector — "Conversation Context": the active AI Chat
 * conversation's own metadata, read straight from the same
 * `useConversations` store `AiWorkspace` (the ai-chat window's content)
 * already drives — no separate data path.
 */
import { PanelSection, PropertyRow } from '@aura/ui';
import { useConversations } from '../../ai/useConversations';

export default function ConversationInspector() {
  const { conversations, activeId, messages, phase } = useConversations();
  const active = conversations.find((c) => c.id === activeId);

  if (!activeId) {
    return (
      <PanelSection title="Conversation Context" icon="spark">
        <div className="rounded-xl border border-dashed border-line px-3 py-4 text-center text-[12px] text-text-subtle">No conversation yet</div>
      </PanelSection>
    );
  }

  return (
    <PanelSection title="Conversation Context" icon="spark">
      <p className="mb-2 truncate text-[12.5px] font-medium text-text">{active?.title ?? 'Untitled conversation'}</p>
      <div className="space-y-2">
        <PropertyRow label="Messages" value={String(messages.length)} />
        <PropertyRow label="State" value={phase} />
      </div>
    </PanelSection>
  );
}
