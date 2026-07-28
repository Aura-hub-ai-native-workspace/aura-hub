# Contributing to AURA

AURA follows a **Maintainer-Driven Development** model. This is not an
open-commit repository — it follows the same governance pattern used by
mature engineering teams (Kubernetes, VS Code, React): contributors propose
changes through Pull Requests, and the repository owner has final say on
everything that lands on `main`.

## Roles & Permissions

See [docs/TEAM_GUIDE.md](docs/TEAM_GUIDE.md) for the full breakdown of
teams, ownership areas, and permissions. Summary:

| Role | Permission | Can push to `main` |
|---|---|---|
| Repository Owner ([@Gokulanand-art](https://github.com/Gokulanand-art)) | Admin | ✅ |
| UI-UX Team | Write | 🚫 |
| Backend Team | Write | 🚫 |
| Database Team | Write | 🚫 |

No contributor can push directly to `main`, regardless of team. See
[docs/BRANCH_PROTECTION.md](docs/BRANCH_PROTECTION.md) for exactly how
this is enforced.

## Workflow

Every contributor follows this sequence, no exceptions:

```
git pull origin main
git checkout -b feature/<feature-name>
# develop
git add .
git commit
git push origin feature/<feature-name>
# open a Pull Request
```

Opening a PR against `main` automatically requests review from
[CODEOWNERS](.github/CODEOWNERS). The repository owner reviews, then
either approves or requests changes. Only the owner merges into `main`.
After merge, delete your feature branch.

```
git pull origin main
   ↓
git checkout -b feature/<feature-name>
   ↓
Develop
   ↓
Commit
   ↓
Push
   ↓
Open Pull Request
   ↓
Repository Owner Review
   ↓
Approve
   ↓
Merge into main
```

## Branch naming

| Prefix | Use for |
|---|---|
| `feature/ui-...` | UI-UX team feature work |
| `feature/backend-...` | Backend team feature work |
| `feature/database-...` | Database team feature work |
| `feature/runtime-...` | AI runtime feature work |
| `bugfix/...` | Non-urgent bug fixes |
| `hotfix/...` | Urgent production fixes |
| `docs/...` | Documentation-only changes |
| `refactor/...` | Refactors with no behavior change |

## Commit convention

AURA uses [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <short summary>
```

Examples:

```
feat(ui): add code editor sidebar
feat(database): add workflow schema
fix(runtime): repair streaming
refactor(core): simplify editor state
docs(readme): improve installation
```

See [docs/CODE_STYLE.md](docs/CODE_STYLE.md) for the full convention and
code style expectations.

## Pull requests

Every PR must include (see the auto-populated
[PR template](.github/pull_request_template.md)):

- Summary
- Problem
- Solution
- Screenshots (if it's a UI change)
- Files Changed (anything non-obvious called out)
- Testing (how you verified it)
- Checklist

## Branch protection on `main`

- Pull requests are required before merging
- At least one approval is required
- Approval from CODEOWNERS is required
- All review conversations must be resolved
- Branches must be up to date before merging
- Force pushes and branch deletion are blocked

Full detail and exact GitHub settings: [docs/BRANCH_PROTECTION.md](docs/BRANCH_PROTECTION.md).
