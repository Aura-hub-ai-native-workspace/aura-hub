/**
 * presentation — domain state → the app's visual vocabulary.
 * ==================================================================
 * The domain package says what a thing *is* (`tone: 'attention'`); this
 * file says what that looks like in AURA's design language. Keeping the
 * mapping in one place means the environment can never drift into its own
 * private palette, and a token change lands everywhere at once.
 */

import type { StatusTone } from '@aura/core';
import type { IconName } from '@aura/ui';
import type { NodeCategory, NodeStatus, Tone } from '@aura/connected-environment';

export const TONE_TO_STATUS: Record<Tone, StatusTone> = {
  positive: 'positive',
  progress: 'info',
  attention: 'attention',
  neutral: 'neutral',
};

export const TONE_DOT: Record<Tone, string> = {
  positive: 'bg-positive',
  progress: 'bg-accent',
  attention: 'bg-attention',
  neutral: 'bg-text-subtle',
};

export const TONE_TEXT: Record<Tone, string> = {
  positive: 'text-positive',
  progress: 'text-accent',
  attention: 'text-attention',
  neutral: 'text-text-subtle',
};

export const STATUS_TONE: Record<NodeStatus, Tone> = {
  connected: 'positive',
  available: 'progress',
  unknown: 'neutral',
  'not-installed': 'attention',
  installing: 'progress',
  uninstalling: 'progress',
  degraded: 'attention',
  'needs-auth': 'progress',
  'no-connector': 'neutral',
};

/** Short label for the card's status chip. */
export const STATUS_LABEL: Record<NodeStatus, string> = {
  connected: 'Connected',
  available: 'Found here',
  unknown: 'Not scanned',
  'not-installed': 'Not installed',
  installing: 'Installing…',
  uninstalling: 'Uninstalling…',
  degraded: 'Degraded',
  'needs-auth': 'Needs sign-in',
  'no-connector': 'Catalogued',
};

export const CATEGORY_ICON: Record<NodeCategory, IconName> = {
  hub: 'spark',
  development: 'code',
  cloud: 'server',
  design: 'layout',
  productivity: 'clipboard',
  ai: 'cpu',
  browser: 'research',
};
