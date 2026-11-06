import { useCallback, useEffect, useRef, useState } from 'react';
import { getGoogle, signOutGoogle, startGoogleSignIn, type GoogleState } from './cloudClient';

/** Google's multicolour "G", as its sign-in branding guidelines require on the button. */
export function GoogleG({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden>
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}

/** "Continue with Google", in Google's own dark/light button style. */
export function GoogleButton({ onClick, busy, tone = 'dark', label = 'Continue with Google' }: {
  onClick: () => void; busy?: boolean; tone?: 'dark' | 'light'; label?: string;
}) {
  const cls = tone === 'dark'
    ? 'border-[#8e918f] bg-[#131314] text-[#e3e3e3] hover:bg-[#1f1f20]'
    : 'border-[#747775] bg-white text-[#1f1f1f] hover:bg-[#f4f4f5]';
  return (
    <button type="button" onClick={onClick} disabled={busy} data-testid="google-button"
      className={`inline-flex h-10 items-center justify-center gap-2.5 rounded-md border px-4 text-[14px] font-medium transition-colors disabled:opacity-60 ${cls}`}>
      <GoogleG />
      <span>{busy ? 'Waiting for Google…' : label}</span>
    </button>
  );
}

/**
 * Google sign-in state, polling while the browser step is open. The consent
 * page opens once in the person's browser (Google does not allow its sign-in
 * inside app windows); everything before and after happens here.
 */
export function useGoogleAccount() {
  const [state, setState] = useState<GoogleState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [waiting, setWaiting] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try { const s = await getGoogle(); setState(s); return s; } catch (e) { setError((e as Error).message); return null; }
  }, []);
  useEffect(() => { void load(); return () => { if (timer.current) clearInterval(timer.current); }; }, [load]);

  const signIn = useCallback(async () => {
    setError(null);
    try {
      await startGoogleSignIn();
      setWaiting(true);
      const started = Date.now();
      if (timer.current) clearInterval(timer.current);
      timer.current = setInterval(async () => {
        const s = await load();
        if (s?.profile || !s?.pending || Date.now() - started > 5 * 60_000) {
          if (timer.current) clearInterval(timer.current);
          setWaiting(false);
          if (!s?.profile) setError('Google sign-in did not finish. Try again.');
        }
      }, 1500);
    } catch (e) { setError((e as Error).message); }
  }, [load]);

  const signOut = useCallback(async () => { await signOutGoogle().catch(() => undefined); await load(); }, [load]);

  return { state, error, waiting, signIn, signOut, reload: load };
}

/** The account card: sign in / who is signed in / where projects go. */
export function GoogleAccountPanel({ tone = 'app' }: { tone?: 'app' | 'dark' }) {
  const { state, error, waiting, signIn, signOut } = useGoogleAccount();
  const muted = tone === 'dark' ? 'text-white/50' : 'text-text-muted';
  const line = tone === 'dark' ? 'border-white/10' : 'border-line';

  if (state && !state.configured) {
    return <p className={`text-[13px] ${muted}`}>Google sign-in is not set up in this build of AURA Hub.</p>;
  }
  const p = state?.profile;
  return (
    <div data-testid="google-account">
      {p ? (
        <div className="flex items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-full border ${line} text-[14px] font-semibold`}>{p.name.slice(0, 1).toUpperCase()}</span>
            <div className="min-w-0">
              <div className="truncate text-[14px] font-medium">{p.name}</div>
              <div className={`truncate text-[12.5px] ${muted}`}>{p.email} · Google</div>
            </div>
          </div>
          <button type="button" onClick={signOut} className={`shrink-0 rounded-md border ${line} px-3.5 py-1.5 text-[12.5px] font-medium hover:bg-black/5`}>Sign out</button>
        </div>
      ) : (
        <div>
          <GoogleButton onClick={signIn} busy={waiting} tone={tone === 'dark' ? 'dark' : 'light'} />
          <p className={`mt-3 text-[12.5px] leading-relaxed ${muted}`}>
            {waiting
              ? 'Finish in the browser window that opened, then come back here. This page updates by itself.'
              : 'Your browser opens once for Google’s sign-in page, then you return here.'}
          </p>
          {waiting && state?.pending && (
            <a href={state.pending.authUrl} target="_blank" rel="noreferrer" className={`mt-1 inline-block text-[12.5px] underline ${muted}`}>Browser didn’t open? Open the sign-in page</a>
          )}
        </div>
      )}
      {error && <p className="mt-3 text-[12.5px] text-red-400">{error}</p>}
    </div>
  );
}
