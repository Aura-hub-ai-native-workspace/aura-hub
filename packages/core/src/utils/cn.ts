import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * `cn` — the class-name composer used by every AURA component.
 * Merges conditional classes (clsx) and resolves Tailwind conflicts
 * (tailwind-merge) so variant props never fight over the same utility.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
