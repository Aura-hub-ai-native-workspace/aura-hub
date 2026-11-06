import { useState } from 'react';
import { AnimatePresence } from 'framer-motion';
import { OnboardingLayout, type OnboardingStep } from './OnboardingLayout';
import { WelcomeScreen } from './WelcomeScreen';
import { AccountSignInScreen } from './AccountSignInScreen';
import { ReadyScreen } from './ReadyScreen';
import { ONBOARDING_STEPS } from './OnboardingLayout';
import { ACCOUNT_LOGIN_ENABLED } from './accountSession';
import { AgentsSetupScreen } from '../agents/AgentsSetupScreen';
import { AgentsSignInPage } from '../agents/AgentsSignInPage';
import { GoogleSignInPage } from '../cloud/GoogleSignInPage';

/**
 * OnboardingFlow — the first-run experience: Welcome → (account, when
 * sign-in is enabled) → Google (optional, for the cloud) → set up the six coding
 * agents → sign in to them → Ready. Plays exactly once (gated by appStore.onboarded);
 * see App.tsx for the mount condition.
 */
export function OnboardingFlow({ onComplete, initialStep = 'welcome' }: {
  onComplete: () => void;
  /** Where the flow opens. Returning users missing a provider open at activation. */
  initialStep?: OnboardingStep;
}) {
  const [step, setStep] = useState<OnboardingStep>(initialStep);
  const steps: readonly OnboardingStep[] = ACCOUNT_LOGIN_ENABLED ? ONBOARDING_STEPS : ONBOARDING_STEPS.filter((s) => s !== 'activate');
  const next = (from: OnboardingStep) => setStep(steps[steps.indexOf(from) + 1] ?? 'ready');

  return (
    <OnboardingLayout step={step} steps={steps}>
      <AnimatePresence mode="wait">
        {step === 'welcome' && <WelcomeScreen key="welcome" onBegin={() => next('welcome')} />}
        {step === 'activate' && (
          <AccountSignInScreen key="activate" onSignedIn={() => next('activate')} />
        )}
        {step === 'google' && <GoogleSignInPage key="google" onContinue={() => next('google')} />}
        {step === 'agents' && <AgentsSetupScreen key="agents" onContinue={() => next('agents')} />}
        {step === 'signin' && <AgentsSignInPage key="signin" onContinue={() => next('signin')} onSkip={() => next('signin')} />}
        {step === 'ready' && <ReadyScreen key="ready" onComplete={onComplete} />}
      </AnimatePresence>
    </OnboardingLayout>
  );
}
