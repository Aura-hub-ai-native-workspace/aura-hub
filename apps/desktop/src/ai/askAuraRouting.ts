/**
 * askAuraRouting — what Ask AURA does with a message, given the routing decision.
 *
 * Conversation keeps the direct answer. Work goes to the mission pipeline,
 * and only with a project folder to run in. A clarification is shown as a
 * question. If the routing decision cannot be obtained, nothing is answered
 * as if it were conversation: that path fails closed.
 */
import type { AskRouteDecision } from './centralAgentClient';

export type AskAction =
  | { kind: 'stream' }
  | { kind: 'clarify'; question: string }
  | { kind: 'mission'; projectPath: string }
  | { kind: 'needs-project' }
  | { kind: 'unavailable' };

export function decideAskAction(
  decision: AskRouteDecision | null,
  projectPath: string | null,
): AskAction {
  if (!decision) return { kind: 'unavailable' };
  if (decision.route === 'conversation') return { kind: 'stream' };
  if (decision.route === 'clarify') {
    return { kind: 'clarify', question: decision.question || 'Could you say more about what you want?' };
  }
  if (decision.route === 'mission') {
    return projectPath ? { kind: 'mission', projectPath } : { kind: 'needs-project' };
  }
  return { kind: 'unavailable' };
}
