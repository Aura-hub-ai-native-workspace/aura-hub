import { useState } from 'react';
import { AnimatePresence } from 'framer-motion';
import { OnboardingLayout, type OnboardingStep } from './OnboardingLayout';
import { WelcomeScreen } from './WelcomeScreen';
import { WorkspaceActivation } from './WorkspaceActivation';
import { ReadyScreen } from './ReadyScreen';

/**
 * OnboardingFlow — the first-run experience: Welcome → Workspace
 * Activation → Ready. Plays exactly once (gated by appStore.onboarded);
 * see App.tsx for the mount condition.
 */
export function OnboardingFlow({ onComplete }: { onComplete: () => void }) {
  const [step, setStep] = useState<OnboardingStep>('welcome');

  return (
    <OnboardingLayout step={step}>
      <AnimatePresence mode="wait">
        {step === 'welcome' && <WelcomeScreen key="welcome" onBegin={() => setStep('activate')} />}
        {step === 'activate' && (
          <WorkspaceActivation key="activate" onActivated={() => setStep('ready')} onOffline={() => setStep('ready')} />
        )}
        {step === 'ready' && <ReadyScreen key="ready" onComplete={onComplete} />}
      </AnimatePresence>
    </OnboardingLayout>
  );
}
