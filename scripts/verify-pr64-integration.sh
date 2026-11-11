#!/usr/bin/env bash
# verify-pr64-integration.sh — disposable rehearsal gate.
# Verifies the PR #64 integration tree against the mandated scope model.
# Exits non-zero on the FIRST failure of any required check.
set -uo pipefail

FAIL=0
step() { printf '\n=== %s ===\n' "$1"; }
ok()   { printf '  [ok] %s\n' "$1"; }
bad()  { printf '  [FAIL] %s\n' "$1"; FAIL=1; }
need() { command -v "$1" >/dev/null 2>&1 || { bad "missing tool: $1"; exit 2; }; }

need node; need npm; need git

step "1. no merge conflict markers in tracked sources"
if git grep -nE "^(<<<<<<< |=======$|>>>>>>> )" -- apps packages backend 2>/dev/null | grep -q .; then
  git grep -nE "^(<<<<<<< |=======$|>>>>>>> )" -- apps packages backend | head -5
  bad "conflict markers present"
else
  ok "no conflict markers"
fi

step "2. git status clean (dist/ and node_modules ignored)"
if [ -n "$(git status --porcelain | grep -v '^?? scripts/verify-pr64-integration.sh$')" ]; then
  git status --porcelain | head -5; bad "unexpected working-tree state"
else
  ok "clean"
fi

step "3. git diff --check"
if git diff --check >/dev/null 2>&1 && git diff --cached --check >/dev/null 2>&1; then ok "clean"; else bad "diff check failed"; fi

step "4. PR #64 scope identifiers present"
grep -q "type ConversationScope = 'project' | 'workspace'" apps/desktop/src/ai/aiClient.ts \
  && ok "scope union (project | workspace)" || bad "scope union missing"
grep -q "kind?: ConversationKind" apps/desktop/src/ai/aiClient.ts \
  && ok "kind field (ask_aura | execution)" || bad "kind field missing"
grep -q "workspace:\${projectId}" apps/desktop/src/screens/WorkspaceScreen.tsx \
  && ok "workspace identity workspace:<projectId>" || bad "workspace identity missing"
grep -q "export class WorkspaceConversations" packages/ai-service/src/conversations.ts \
  && ok "WorkspaceConversations store" || bad "WorkspaceConversations missing"
grep -q "protected owns(" packages/ai-service/src/conversations.ts \
  && ok "ConversationFileStore scope guard" || bad "scope guard missing"
grep -q "export function migrateConversation" packages/ai-service/src/conversations.ts \
  && ok "read-time migration" || bad "migration missing"
grep -q "workspaceFileName" packages/ai-service/src/conversations.ts \
  && ok "Windows-safe file names" || bad "Windows-safe naming missing"
grep -q "export class HandoffStore" packages/ai-service/src/handoffs.ts \
  && ok "HandoffStore" || bad "HandoffStore missing"
grep -q "'accepted'" packages/ai-service/src/handoffs.ts && grep -q "'cancelled'" packages/ai-service/src/handoffs.ts \
  && ok "handoff lifecycle states" || bad "handoff lifecycle missing"
grep -q "'ask-aura'" packages/ai-service/src/server.ts \
  && ok "project handoff routes" || bad "project handoff routes missing"
grep -q "'workspaces' && seg.length >= 2" packages/ai-service/src/server.ts \
  && ok "workspace conversation/handoff routes" || bad "workspace routes missing"
grep -q "loadForWorkspace" apps/desktop/src/ai/useAgentConversations.ts \
  && ok "scope-aware engine" || bad "scope-aware engine missing"
grep -q "const owner: Owner" apps/desktop/src/ai/useAgentConversations.ts \
  && ok "per-turn captured owner" || bad "owner capture missing"
grep -q "handoffToWorkspace" apps/desktop/src/ai/useAgentConversations.ts \
  && ok "handoffToWorkspace" || bad "handoffToWorkspace missing"
grep -q "data-testid=\"workspace-chat-title\"" apps/desktop/src/screens/workspace/neon/ConversationPane.tsx \
  && ok "Execution Chat UI" || bad "Execution Chat UI missing"
grep -q "scope-project" apps/desktop/src/screens/ai/AiWorkspace.tsx \
  && ok "Ask AURA scope label" || bad "scope label missing"
grep -q "send-to-workspace" apps/desktop/src/screens/ai/AiWorkspace.tsx \
  && ok "Send to Workspace dialog" || bad "send-to-workspace missing"

step "5. superseded architecture must NOT resurface"
grep -rn "WORKSPACE_SCOPE_ID\|__workspace__" packages/ai-service/src apps/desktop/src --include='*.ts' --include='*.tsx' >/dev/null 2>&1 \
  && bad "sentinel workspace scope resurfaced" || ok "no __workspace__ sentinel"
grep -q "useWorkspaceConversations" apps/desktop/src/ai/useAgentConversations.ts \
  && bad "cf two-store factory resurfaced" || ok "single scope-aware engine"
grep -rn "'/workspace/conversations'" apps/desktop/src/ai/aiClient.ts >/dev/null 2>&1 \
  && bad "stale global workspace routes in client" || ok "no stale global workspace routes"
grep -cn "seg\[0\] === 'workspaces'" packages/ai-service/src/server.ts | grep -qx "1" \
  && ok "exactly one /workspaces route block" || bad "route block duplicated or missing"

step "6. typecheck"
if npm run --silent typecheck >/tmp/pr64-typecheck.log 2>&1; then ok "typecheck"; else tail -5 /tmp/pr64-typecheck.log; bad "typecheck"; fi

step "7. frontend tests"
if npm run --silent test:front >/tmp/pr64-testfront.log 2>&1; then
  ok "test:front ($(grep -oE 'Tests +[0-9]+ passed' /tmp/pr64-testfront.log | tail -1))"
else tail -12 /tmp/pr64-testfront.log; bad "test:front"; fi

step "8. service tests"
if npm run --silent test:service >/tmp/pr64-testservice.log 2>&1; then
  ok "test:service ($(grep -oE 'Tests +[0-9]+ passed' /tmp/pr64-testservice.log | tail -1))"
else tail -12 /tmp/pr64-testservice.log; bad "test:service"; fi

step "9. production build"
if npm run --silent build >/tmp/pr64-build.log 2>&1; then ok "build"; else tail -8 /tmp/pr64-build.log; bad "build"; fi

printf '\n'
if [ "$FAIL" -eq 0 ]; then echo "ALL CHECKS PASSED"; exit 0; else echo "CHECKS FAILED"; exit 1; fi
