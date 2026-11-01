import { useState } from 'react';
import { AnimatePresence } from 'framer-motion';
import { OnboardingLayout, type OnboardingStep } from './OnboardingLayout';
import { WelcomeScreen } from './WelcomeScreen';
import { AccountSignInScreen } from './AccountSignInScreen';
import { ReadyScreen } from './ReadyScreen';

/**
 * OnboardingFlow — the first-run experience: Welcome → Workspace
 * Activation → Ready. Plays exactly once (gated by appStore.onboarded);
 * see App.tsx for the mount condition.
 */
export function OnboardingFlow({ onComplete, initialStep = 'welcome' }: {
  onComplete: () => void;
  /** Where the flow opens. Returning users missing a provider open at activation. */
  initialStep?: OnboardingStep;
}) {
  const [step, setStep] = useState<OnboardingStep>(initialStep);

  return (
    <OnboardingLayout step={step}>
      <AnimatePresence mode="wait">
        {step === 'welcome' && <WelcomeScreen key="welcome" onBegin={() => setStep('activate')} />}
        {step === 'activate' && (
          <AccountSignInScreen key="activate" onSignedIn={() => setStep('ready')} />
        )}
        {step === 'ready' && <ReadyScreen key="ready" onComplete={onComplete} />}
      </AnimatePresence>
    </OnboardingLayout>
  );
}
