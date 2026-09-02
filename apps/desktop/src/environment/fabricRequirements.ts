/**
 * fabricRequirements — the Fabric's own core execution surface.
 * ==================================================================
 * Per §27 of the mission brief, the architecture is proven with a small
 * set of real capabilities rather than a hundred integrations. This is
 * that set, and it is what the Connected Environment screen measures
 * readiness against.
 *
 * It is deliberately NOT a mission and not derived from one — it is a
 * standing question ("is this machine equipped to execute?") that has a
 * true answer whether or not a mission exists. Requirements for a live
 * mission are derived by the Fabric from the authoritative
 * `MissionRecord`; see docs/CONSOLIDATION_MAP.md.
 */

import type { CapabilityRequirement } from '@aura/connected-environment';

export const FABRIC_CORE_REQUIREMENTS: CapabilityRequirement[] = [
  { capability: 'source-control' },
  { capability: 'terminal' },
  { capability: 'language-runtime' },
  { capability: 'package-manager' },
  { capability: 'code-hosting' },
  { capability: 'browser-automation' },
  { capability: 'container-runtime' },
];
