/** The signed-in account this window remembers. The session token is checked by the service. */

export const ACCOUNT_KEY = 'aura.account';
/** Fired in this window whenever the signed-in account changes (the storage event covers other windows). */
export const ACCOUNT_EVENT = 'aura:account-changed';

function announce(): void {
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(new Event(ACCOUNT_EVENT));
  }
}

export interface SignedInAccount {
  email: string;
  name: string;
  token: string;
  /** Renews the session when the cloud provider's short-lived token expires. */
  refreshToken?: string;
}

export function readAccount(storage: Pick<Storage, 'getItem'> = localStorage): SignedInAccount | null {
  try {
    const raw = storage.getItem(ACCOUNT_KEY);
    if (!raw) return null;
    const a = JSON.parse(raw) as Partial<SignedInAccount>;
    if (typeof a.email !== 'string' || typeof a.token !== 'string' || !a.token) return null;
    return {
      email: a.email, name: String(a.name ?? a.email), token: a.token,
      ...(typeof a.refreshToken === 'string' && a.refreshToken ? { refreshToken: a.refreshToken } : {}),
    };
  } catch {
    return null;
  }
}

export function writeAccount(account: SignedInAccount, storage: Pick<Storage, 'setItem'> = localStorage): void {
  try {
    storage.setItem(ACCOUNT_KEY, JSON.stringify(account));
  } catch {
    /* storage unavailable: the sign-in lasts for this run only */
  }
  announce();
}

export function clearAccount(storage: Pick<Storage, 'removeItem'> = localStorage): void {
  try {
    storage.removeItem(ACCOUNT_KEY);
  } catch {
    /* nothing to clear */
  }
  announce();
}

/** Sign-in is switched off for now (owner's decision). The screen, the service routes and the saved-session
 *  logic stay in place; turn this on to require an account again. */
export const ACCOUNT_LOGIN_ENABLED = false;
