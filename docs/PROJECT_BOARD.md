# AURA Development — Project Board

AURA tracks all work on a single GitHub Projects (v2) board named
**"AURA Development"**, owned by the
[Aura-hub-ai-native-workspace](https://github.com/orgs/Aura-hub-ai-native-workspace/projects)
organization.

## Columns (Status field)

| Column | Meaning |
|---|---|
| **Backlog** | Captured but not yet scoped or scheduled |
| **Todo** | Scoped, ready to be picked up |
| **In Progress** | Actively being worked on in a feature branch |
| **Review** | PR open, awaiting CODEOWNERS review/approval |
| **Testing** | Approved, being verified (manual QA, CI, or pre-release checks) |
| **Done** | Merged into `main` |

## Automation rules

- New issues → **Backlog**
- Issue assigned + branch opened → **Todo** → move to **In Progress** manually by the assignee
- PR opened, linked to an issue → **Review**
- PR approved by CODEOWNERS → **Testing**
- PR merged → **Done**, linked issue auto-closed

## Views

- **Board view** — grouped by Status column (default)
- **Table view** — grouped by team label (`ui`, `backend`, `database`, `runtime`, `knowledge-fabric`, `workflow`) for team leads to filter their own queue
- **Milestone view** — filtered to the current milestone (e.g. `AURA Presentation v0.1`) for presentation/release readiness

## How to create this if it doesn't exist yet

```bash
gh auth refresh -s project,read:project   # one-time scope grant
gh project create --owner Aura-hub-ai-native-workspace --title "AURA Development"

# Add the Status options to match the columns above via the web UI:
# Project → Settings → Fields → Status → add: Backlog, Todo, In Progress, Review, Testing, Done
```

Or via the GitHub web UI: **Organization → Projects → New project → Board template**, then rename the default columns to match the table above.
