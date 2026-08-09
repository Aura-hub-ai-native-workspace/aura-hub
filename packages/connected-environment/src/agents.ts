/**
 * agents — the specialist roles a mission is carried by.
 * ==================================================================
 * A role is a *responsibility*, not a model and not a thread. The
 * orchestrator assigns tasks to roles; a role is then carried out by
 * whichever node provides the capability the task declared. That
 * indirection is what lets the same plan run on a local coding agent
 * today and a different one tomorrow without the plan changing.
 *
 * Icons are names from the @aura/ui registry so the environment renders
 * roles in the same visual language as everything else.
 */

import type { AgentRole } from './types';

export interface AgentMeta {
  role: AgentRole;
  label: string;
  /** What this role is accountable for, in one line. */
  focus: string;
  icon: string;
}

export const AGENTS: Record<AgentRole, AgentMeta> = {
  planner: { role: 'planner', label: 'Planner', focus: 'Turns the request into a goal, assumptions and a plan.', icon: 'clipboard' },
  architect: { role: 'architect', label: 'Architect', focus: 'Decides structure, boundaries and technology.', icon: 'architecture' },
  designer: { role: 'designer', label: 'Designer', focus: 'Owns the design language and the screens.', icon: 'layout' },
  frontend: { role: 'frontend', label: 'Frontend Engineer', focus: 'Builds the interface and its state.', icon: 'code' },
  backend: { role: 'backend', label: 'Backend Engineer', focus: 'Builds the services and business rules.', icon: 'server' },
  database: { role: 'database', label: 'Database Engineer', focus: 'Models, provisions and migrates the data.', icon: 'database' },
  security: { role: 'security', label: 'Security Engineer', focus: 'Guards inputs, secrets and authorization.', icon: 'shield' },
  testing: { role: 'testing', label: 'Testing Engineer', focus: 'Proves the behaviour actually holds.', icon: 'flask' },
  devops: { role: 'devops', label: 'DevOps Engineer', focus: 'Scaffolding, builds, containers and pipelines.', icon: 'terminal' },
  deployment: { role: 'deployment', label: 'Deployment Engineer', focus: 'Gets it running somewhere reachable.', icon: 'deploy' },
  documentation: { role: 'documentation', label: 'Documentation Engineer', focus: 'Makes the result usable by someone else.', icon: 'doc' },
  reviewer: { role: 'reviewer', label: 'Reviewer', focus: 'Reads the change for what will age badly.', icon: 'eye' },
  debugger: { role: 'debugger', label: 'Debugger', focus: 'Reproduces, isolates and explains failures.', icon: 'bug' },
  optimizer: { role: 'optimizer', label: 'Optimizer', focus: 'Measures first, then removes the real cost.', icon: 'activity' },
};

export const AGENT_ROLES = Object.keys(AGENTS) as AgentRole[];

export function agentMeta(role: AgentRole): AgentMeta {
  return AGENTS[role];
}
