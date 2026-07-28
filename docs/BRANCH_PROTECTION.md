# Branch Protection — `main`

This document is the source of truth for how `main` is protected on
[Aura-hub-ai-native-workspace/aura-hub](https://github.com/Aura-hub-ai-native-workspace/aura-hub).
If protection is ever reset (repo transfer, new repo, disaster recovery),
recreate it exactly as described here.

## Current configuration

| Setting | Value |
|---|---|
| Require a pull request before merging | ✅ Enabled |
| Required approving reviews | 1 |
| Require review from Code Owners | ✅ Enabled |
| Dismiss stale reviews on new commits | ✅ Enabled |
| Require conversation resolution before merging | ✅ Enabled |
| Require status checks to pass | ✅ `Typecheck & Build` (CI), must be up to date with `main` |
| Require signed commits | Off |
| Require linear history | Off |
| Allow force pushes | 🚫 Blocked |
| Allow branch deletion | 🚫 Blocked |
| Do not allow bypassing the above settings (admins) | Off — the repository owner may bypass to unblock emergencies; every other collaborator (Write-permission team members) cannot |

Effectively: **no one except the repository owner can push directly to
`main`.** UI/UX, Backend, and Database teams hold `Write` (push)
permission on the repo but not `Admin`, so GitHub itself refuses their
direct pushes to a protected branch — they are structurally limited to
opening Pull Requests.

## How to configure this in the GitHub UI

`Settings → Branches → Branch protection rules → main`

1. **Require a pull request before merging**
   - Require approvals: `1`
   - Require review from Code Owners: on
   - Dismiss stale pull request approvals when new commits are pushed: on
2. **Require status checks to pass before merging**
   - Require branches to be up to date before merging: on
   - Status check: `Typecheck & Build`
3. **Require conversation resolution before merging**: on
4. **Do not allow bypassing the above settings**: off (owner bypass allowed)
5. **Restrict who can push to matching branches**: not available on GitHub
   Free for user-owned repos/orgs without a paid plan; not required here
   because Write-permission collaborators cannot push to a protected
   branch that requires PR review regardless of this setting.
6. **Allow force pushes**: off
7. **Allow deletions**: off

## How to configure via `gh` / REST API

```bash
gh api -X PUT repos/Aura-hub-ai-native-workspace/aura-hub/branches/main/protection \
  -H "Accept: application/vnd.github+json" \
  --input - <<'EOF'
{
  "required_status_checks": {
    "strict": true,
    "contexts": ["Typecheck & Build"]
  },
  "enforce_admins": false,
  "required_pull_request_reviews": {
    "required_approving_review_count": 1,
    "require_code_owner_reviews": true,
    "dismiss_stale_reviews": true
  },
  "restrictions": null,
  "required_conversation_resolution": true,
  "required_linear_history": false,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "block_creations": false,
  "lock_branch": false
}
EOF
```

## Note on GitHub plan limits

Branch protection rules on GitHub Free are only available on **public**
repositories for user/org accounts without GitHub Pro/Team/Enterprise.
`aura-hub` is public for this reason. If the repository is ever made
private without a paid plan, branch protection will be silently dropped
and must be reconfigured after upgrading or reverting to public.
