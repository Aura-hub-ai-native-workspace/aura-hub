# AURA Team Guide

AURA is built by a small set of focused teams under a single repository
owner. This document defines who owns what, what permission each team
holds, and how to get access.

## Teams

### 👑 Repository Owner

**GitHub**: [@Gokulanand-art](https://github.com/Gokulanand-art) · **Permission**: Admin

Owns:
- Architecture
- AI Runtime
- Knowledge Fabric
- Final reviews
- Merge decisions
- Releases
- Repository governance (branch protection, CODEOWNERS, CI, teams)

No PR merges into `main` without the owner's explicit approval — see
[BRANCH_PROTECTION.md](BRANCH_PROTECTION.md) for enforcement details.

### 🎨 UI-UX Team

**GitHub team**: [`ui-ux-team`](https://github.com/orgs/Aura-hub-ai-native-workspace/teams/ui-ux-team) · **Permission**: Write

Owns:
- Desktop UI (`apps/desktop`)
- Design system (`packages/ui`)
- Components
- Editor UI
- Animations (`packages/core/src/motion.ts` and friends)

### ⚙ Backend Team

**GitHub team**: [`backend-team`](https://github.com/orgs/Aura-hub-ai-native-workspace/teams/backend-team) · **Permission**: Write

Owns:
- API (`packages/ai-service`)
- Project indexing (`packages/knowledge-coding`, `packages/knowledge-fullstack`)
- Workflow engine (`packages/ai-service/src/workflow`)
- Knowledge APIs (`packages/retrieval`, `packages/intelligence`)

### 🗄 Database Team

**GitHub team**: [`database-team`](https://github.com/orgs/Aura-hub-ai-native-workspace/teams/database-team) · **Permission**: Write

Owns:
- Persistence
- Schema
- Storage
- Migration
- Search (index storage/query layers within `packages/knowledge-coding`,
  `packages/knowledge-fullstack`, and `packages/retrieval`)

## Permission model

| Role | Direct push to `main` | Merge PRs | Approve PRs | Repo settings |
|---|---|---|---|---|
| Repository Owner | ✅ | ✅ | ✅ | ✅ |
| UI-UX / Backend / Database (Write) | 🚫 | 🚫 | Can review, cannot be the required approval unless also a CODEOWNER | 🚫 |

Write access lets a team clone, branch, push feature branches, and open
PRs. It does not grant merge rights on a protected branch — see
[BRANCH_PROTECTION.md](BRANCH_PROTECTION.md).

## Getting added to a team

Ask the repository owner to invite your GitHub username to the relevant
team in the [Aura-hub-ai-native-workspace](https://github.com/orgs/Aura-hub-ai-native-workspace/people)
organization. Team membership determines which `Write`-permission group
you're in; it does not itself grant approval rights on `main`.
