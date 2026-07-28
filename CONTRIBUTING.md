# Contributing to AURA

AURA follows a **Maintainer-Driven Development** model. This is not an
open-commit repository — it follows the same governance pattern used by
mature engineering teams (Kubernetes, VS Code, React): contributors propose
changes through Pull Requests, and the maintainer has final say on
everything that lands on `main`.

## Roles & Permissions

### Repository Owner ([@Gokulanand-art](https://github.com/Gokulanand-art))

Founder, Project Lead, System Architect, and Repository Administrator.

Responsible for: architecture, code quality, AI runtime, knowledge fabric,
security, final reviews, merge decisions, and releases. No code reaches
`main` without explicit owner approval.

Has: full admin access, direct push to `main`, PR merge rights, release
management, GitHub Actions and secrets management, branch protection
management, team management, and final review/approval on every change.

### UI/UX Team — Write access

Can: clone, create feature branches, commit, push feature branches, open
PRs, comment on and review other PRs.

Cannot: push to `main`, merge PRs, change repository settings, delete
branches, disable workflows, or modify repository security.

### Backend & Database Team — Write access

Can: clone, create feature branches, push feature branches, open PRs,
review PRs.

Cannot: push directly to `main`, merge into `main`, delete branches, modify
repository settings, change branch protection, or manage secrets.

## Workflow

Every contributor follows this sequence:

```
git pull origin main
git checkout -b feature/<feature-name>
# make changes
git add .
git commit
git push origin feature/<feature-name>
# open a Pull Request
```

Opening a PR against `main` automatically requests review from
[CODEOWNERS](.github/CODEOWNERS). The maintainer reviews, then either
approves or requests changes. Only the maintainer merges into `main`.
After merge, delete your feature branch.

## Branch protection on `main`

- Pull requests are required before merging
- At least one approval is required
- Approval from CODEOWNERS is required
- All review conversations must be resolved
- Branches must be up to date before merging
- Force pushes and branch deletion are blocked
- Direct pushes are restricted to the repository owner

No contributor can push directly to `main`, regardless of role.
