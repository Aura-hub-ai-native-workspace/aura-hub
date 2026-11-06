import { AuraLogo } from '../brand/AuraLogo';
import { GoogleButton, useGoogleAccount } from './GoogleAccount';

const POINTS = [
  ['Your Google storage becomes AURA’s cloud', 'Send any project to Google Drive › AURA Hub and restore it on any machine.'],
  ['Narrow access', 'AURA can only see the files it creates in your Drive — never anything else.'],
  ['Secrets never leave this device', '.env files, private keys and credentials are left out of every cloud copy.'],
] as const;

/**
 * First launch: optional "Continue with Google". The consent page opens once in
 * the browser (Google requires it); the person comes back here, signed in.
 */
export function GoogleSignInPage({ onContinue }: { onContinue: () => void }) {
  const { state, error, waiting, signIn } = useGoogleAccount();
  const p = state?.profile;
  return (
    <div className="fixed inset-0 z-[310] overflow-y-auto bg-[#0a0a0b] text-white" data-testid="google-signin-page">
      <div className="mx-auto grid min-h-full w-full max-w-[1080px] grid-cols-1 items-start gap-10 px-8 py-14 md:grid-cols-12 md:py-20">
        <aside className="md:col-span-5 md:pt-2">
          <div className="flex items-center gap-2.5">
            <AuraLogo size={22} />
            <span className="text-[13px] font-semibold tracking-[0.01em] text-white/80">AURA Hub</span>
          </div>
          <h1 className="mt-10 text-[30px] font-semibold leading-[1.15] tracking-[-0.02em]">Sign in to AURA Hub</h1>
          <p className="mt-3 max-w-sm text-[14px] leading-relaxed text-white/55">Use your Google account to keep your projects safe in the cloud.</p>
          <ul className="mt-10 space-y-6">
            {POINTS.map(([title, body]) => (
              <li key={title} className="flex gap-3">
                <svg width="16" height="16" viewBox="0 0 16 16" className="mt-0.5 shrink-0 text-white/50" aria-hidden>
                  <path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <div>
                  <div className="text-[13.5px] font-medium text-white/90">{title}</div>
                  <div className="mt-0.5 text-[12.5px] leading-relaxed text-white/45">{body}</div>
                </div>
              </li>
            ))}
          </ul>
        </aside>

        <section className="md:col-span-7">
          <div className="mx-auto max-w-[440px] rounded-xl border border-white/10 bg-[#111113] px-8 py-9">
            {p ? (
              <>
                <h2 className="text-[18px] font-semibold">You’re signed in</h2>
                <div className="mt-5 flex items-center gap-3 rounded-lg border border-white/10 px-4 py-3">
                  <span className="grid h-9 w-9 place-items-center rounded-full border border-white/15 text-[13px] font-semibold">{p.name.slice(0, 1).toUpperCase()}</span>
                  <div className="min-w-0">
                    <div className="truncate text-[14px] font-medium">{p.name}</div>
                    <div className="truncate text-[12.5px] text-white/50">{p.email}</div>
                  </div>
                </div>
                <button type="button" onClick={onContinue} className="mt-6 h-10 w-full rounded-md bg-white text-[14px] font-semibold text-black hover:bg-white/90">Continue</button>
              </>
            ) : (
              <>
                <h2 className="text-[18px] font-semibold">Sign in</h2>
                <p className="mt-1 text-[13px] text-white/50">to continue to AURA Hub</p>
                <div className="mt-7">
                  {state && !state.configured ? (
                    <p className="text-[13px] text-white/50">Google sign-in is not set up in this build.</p>
                  ) : (
                    <div className="[&>button]:w-full"><GoogleButton onClick={signIn} busy={waiting} /></div>
                  )}
                </div>
                <p className="mt-4 text-[12.5px] leading-relaxed text-white/45">
                  {waiting ? 'Finish in the browser window that opened. This page updates by itself.' : 'Your browser opens once for Google’s sign-in page, then you return here.'}
                </p>
                {waiting && state?.pending && (
                  <a href={state.pending.authUrl} target="_blank" rel="noreferrer" className="mt-1 inline-block text-[12.5px] text-white/60 underline">Browser didn’t open? Open the sign-in page</a>
                )}
                {error && <p className="mt-3 text-[12.5px] text-red-300">{error}</p>}
                <div className="mt-8 border-t border-white/[0.07] pt-5 text-center">
                  <button type="button" onClick={onContinue} className="text-[12.5px] font-medium text-white/55 hover:text-white">Skip for now</button>
                </div>
              </>
            )}
          </div>
          <p className="mt-4 text-center text-[11.5px] text-white/35">Google’s Terms of Service and Privacy Policy apply to Google sign-in.</p>
        </section>
      </div>
    </div>
  );
}
