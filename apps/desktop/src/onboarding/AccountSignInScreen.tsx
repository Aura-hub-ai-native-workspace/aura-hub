import { useEffect, useState, type FormEvent } from 'react';
import { motion } from 'framer-motion';
import { accountStatus, signIn, signUp, type AccountStatus } from './accountClient';
import { writeAccount } from './accountSession';

/**
 * Sign in to AURA Hub with an individual account, entirely inside the hub window: no
 * browser and no redirect. The account is kept on this machine, or in the owner's Supabase
 * project when one is configured, and the screen says which. On a machine with no local
 * account yet, it opens as sign-up.
 */
export function AccountSignInScreen({ onSignedIn }: { onSignedIn: () => void }) {
  const [mode, setMode] = useState<'sign-in' | 'sign-up'>('sign-in');
  const [touchedMode, setTouchedMode] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [status, setStatus] = useState<AccountStatus | null>(null);

  // First run on this machine: there is no account to sign in to, so start at sign-up.
  useEffect(() => {
    let cancelled = false;
    void accountStatus().then((st) => {
      if (cancelled) return;
      setStatus(st);
      if (st && !st.hasAccounts && !touchedMode) setMode('sign-up');
    });
    return () => {
      cancelled = true;
    };
  }, [touchedMode]);

  const signingUp = mode === 'sign-up';

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setError(null);
    setNotice(null);
    if (signingUp && password !== confirm) {
      setError('The two passwords are not the same.');
      return;
    }
    setBusy(true);
    const result = signingUp ? await signUp(email, password, name) : await signIn(email, password);
    setBusy(false);
    if (!result.ok) {
      if (result.pendingConfirmation) {
        // The account exists; it needs its email confirmed before the first sign-in.
        setNotice(result.message);
        setMode('sign-in');
        setPassword('');
        setConfirm('');
        return;
      }
      setError(result.message);
      return;
    }
    writeAccount(result.account);
    onSignedIn();
  };

  const field = 'w-full rounded-xl border border-white/15 bg-white/5 px-3.5 py-2.5 text-[14px] text-white placeholder:text-white/35 focus:border-white/40 focus:outline-none';

  return (
    <motion.section
      aria-label={signingUp ? 'Create your AURA Hub account' : 'Sign in to AURA Hub'}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      className="mx-auto flex max-w-[460px] flex-col gap-6 px-6 py-10"
    >
      <div>
        <p className="text-[12px] font-medium uppercase tracking-wide text-white/45">Your account</p>
        <h1 className="mt-2 text-[32px] font-semibold tracking-[-0.02em] text-white">
          {signingUp ? 'Create your AURA Hub account' : 'Sign in to AURA Hub'}
        </h1>
        <p className="mt-3 text-[14px] leading-relaxed text-white/60">
          {status?.provider === 'supabase'
            ? 'Your account is kept in your own Supabase project. AURA Hub never stores your password.'
            : 'Your account stays on this machine. Nothing is sent anywhere else.'}
        </p>
      </div>

      <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3.5">
        {signingUp && (
          <input className={field} aria-label="Your name" placeholder="Your name (optional)" autoComplete="name"
            value={name} onChange={(e) => setName(e.target.value)} />
        )}
        <input className={field} type="email" aria-label="Gmail address" placeholder="you@gmail.com" autoComplete="email" required
          value={email} onChange={(e) => setEmail(e.target.value)} />
        <input className={field} type="password" aria-label="Password" placeholder="Password" required
          autoComplete={signingUp ? 'new-password' : 'current-password'}
          value={password} onChange={(e) => setPassword(e.target.value)} />
        {signingUp && (
          <input className={field} type="password" aria-label="Confirm password" placeholder="Confirm password" required autoComplete="new-password"
            value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        )}
        {notice && <p role="status" className="text-[12.5px] text-white/70">{notice}</p>}
        {error && <p role="alert" className="text-[12.5px] text-red-300">{error}</p>}
        <button
          type="submit"
          disabled={busy}
          className="rounded-xl border border-white/20 bg-white px-4 py-3 text-[14px] font-medium text-black transition-opacity disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? 'One moment…' : signingUp ? 'Create account' : 'Sign in'}
        </button>
      </form>

      <button
        type="button"
        onClick={() => { setTouchedMode(true); setMode(signingUp ? 'sign-in' : 'sign-up'); setError(null); }}
        className="self-start text-[13px] text-white/55 underline-offset-2 hover:text-white/80 hover:underline"
      >
        {signingUp ? 'I already have an account' : 'Create a new account'}
      </button>
    </motion.section>
  );
}
