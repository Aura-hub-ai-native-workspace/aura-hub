/**
 * Content checksums — real sha1 over file bytes, for change detection.
 */

import { createHash } from 'node:crypto';

export function sha1(data: Buffer | string): string {
  return createHash('sha1').update(data).digest('hex');
}
