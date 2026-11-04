import { create } from 'zustand';
import { DEFAULT_AGENTS, fetchAgentChoice, type AgentChoice, type AgentId } from './agentsClient';

/**
 * Which coding agents are in this workspace. Four by default; the person can
 * remove any and add others on the sign-in page. Home, the Workspace members
 * and auto-connect all read this one list.
 */
export const useAgentChoice = create<{
  selected: AgentId[];
  available: AgentChoice['available'];
  loaded: boolean;
  load: () => Promise<void>;
}>((set) => ({
  selected: DEFAULT_AGENTS,
  available: [],
  loaded: false,
  load: async () => {
    try {
      const c = await fetchAgentChoice();
      set({ selected: c.selected, available: c.available, loaded: true });
    } catch { /* keep the defaults until the service answers */ }
  },
}));
