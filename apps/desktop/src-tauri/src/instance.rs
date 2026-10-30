//! Instance ownership: the desktop shell's half of the handshake.
//!
//! The shell creates a fresh random token for every backend it launches and
//! hands it to that child in its environment. It then asks the child to prove
//! it holds the token: the child answers `HMAC-SHA256(token, "aura-instance-proof:" + c)`
//! for a challenge `c` the shell picks freshly each time. This module computes
//! the expected answer and compares it in constant time. The matching server
//! side is `backend/aura/api/instance_guard.py` and
//! `packages/ai-service/src/instanceGuard.ts`; the test vectors below were
//! produced by the Python implementation, so the two cannot drift silently.
//!
//! Tokens never reach a command line, a log line, or a public response.

use sha2::{Digest, Sha256};

const PROOF_PREFIX: &str = "aura-instance-proof:";
const BLOCK: usize = 64;

/// A fresh launch token: 32 random bytes, hex. Failure to read the OS random
/// source is fatal to the launch rather than a reason to fall back to a
/// predictable value.
pub fn new_token() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes)
        .map_err(|e| format!("could not read the operating system's random source: {e}"))?;
    Ok(hex(&bytes))
}

/// A fresh challenge for one ownership check. Letters and digits only, which
/// is the shape the backends accept.
pub fn new_challenge() -> Result<String, String> {
    let mut bytes = [0u8; 16];
    getrandom::getrandom(&mut bytes)
        .map_err(|e| format!("could not read the operating system's random source: {e}"))?;
    Ok(hex(&bytes))
}

/// The answer a genuine instance gives to `challenge`.
pub fn expected_proof(token: &str, challenge: &str) -> String {
    let msg = format!("{PROOF_PREFIX}{challenge}");
    hex(&hmac_sha256(token.as_bytes(), msg.as_bytes()))
}

/// Compare two values without leaking where they first differ.
pub fn constant_time_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// HMAC-SHA256 (RFC 2104), written over `sha2` so no further crate is needed.
pub fn hmac_sha256(key: &[u8], msg: &[u8]) -> [u8; 32] {
    let mut k = [0u8; BLOCK];
    if key.len() > BLOCK {
        k[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        k[..key.len()].copy_from_slice(key);
    }
    let mut ipad = [0x36u8; BLOCK];
    let mut opad = [0x5cu8; BLOCK];
    for i in 0..BLOCK {
        ipad[i] ^= k[i];
        opad[i] ^= k[i];
    }
    let mut inner = Sha256::new();
    inner.update(ipad);
    inner.update(msg);
    let inner = inner.finalize();
    let mut outer = Sha256::new();
    outer.update(opad);
    outer.update(inner);
    outer.finalize().into()
}

fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(DIGITS[(b >> 4) as usize] as char);
        s.push(DIGITS[(b & 0x0f) as usize] as char);
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hmac_matches_rfc_4231_test_case_2() {
        assert_eq!(
            hex(&hmac_sha256(b"Jefe", b"what do ya want for nothing?")),
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
    }

    #[test]
    fn proof_matches_the_python_backend() {
        // Produced by backend/aura/api/instance_guard.py::proof_for.
        assert_eq!(
            expected_proof("tok-known-answer-0123456789abcdef", "abcdef0123456789abcdef"),
            "57b517cbf846c2d26f37e52224d0fcc33ec2da517c5161f10d5d8d97aff59bd9"
        );
    }

    #[test]
    fn a_proof_is_bound_to_its_token_and_challenge() {
        let p = expected_proof("token-a", "challenge-1234567890");
        assert_ne!(p, expected_proof("token-b", "challenge-1234567890"));
        assert_ne!(p, expected_proof("token-a", "challenge-0987654321"));
    }

    #[test]
    fn constant_time_eq_is_exact() {
        assert!(constant_time_eq("abc", "abc"));
        assert!(!constant_time_eq("abc", "abd"));
        assert!(!constant_time_eq("abc", "abcd"));
        assert!(!constant_time_eq("", "a"));
    }

    #[test]
    fn tokens_and_challenges_are_fresh_and_well_formed() {
        let (a, b) = (new_token().unwrap(), new_token().unwrap());
        assert_eq!(a.len(), 64);
        assert_ne!(a, b);
        let c = new_challenge().unwrap();
        assert!(c.len() >= 16 && c.len() <= 128 && c.bytes().all(|x| x.is_ascii_alphanumeric()));
    }
}
