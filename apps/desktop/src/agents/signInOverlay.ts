import { create } from 'zustand';

/** Whether the agents' sign-in page is open over the app (outside onboarding). */
export const useAgentsSignIn = create<{ open: boolean; show: () => void; hide: () => void }>((set) => ({
  open: false,
  show: () => set({ open: true }),
  hide: () => set({ open: false }),
}));
