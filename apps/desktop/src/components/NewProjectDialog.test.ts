import { describe, expect, it } from 'vitest';
import { describeLocation } from './NewProjectDialog';

describe('the create-project dialog says only what the service said', () => {
  it('shows the service-resolved target, never a hard-coded default', () => {
    const text = describeLocation({ parent: '/data/p', dirName: 'greeting-check', target: '/data/p/greeting-check', overridden: true, renamed: false });
    expect(text).toContain('/data/p/greeting-check');
    expect(text).toContain('AURA_PROJECTS_DIR');
    expect(text).not.toContain('~/AuraProjects');
  });
  it('shows the default path when that is what the service answered', () => {
    const text = describeLocation({ parent: '/home/u/AuraProjects', dirName: 'x', target: '/home/u/AuraProjects/x', overridden: false, renamed: false });
    expect(text).toContain('/home/u/AuraProjects/x');
    expect(text).not.toContain('AURA_PROJECTS_DIR');
  });
  it('says a number was added when the folder name was taken', () => {
    expect(describeLocation({ parent: '/p', dirName: 'a-2', target: '/p/a-2', overridden: false, renamed: true })).toContain('number was added');
  });
  it('does not guess a path while waiting or after a failure', () => {
    expect(describeLocation(null)).toContain('Working out');
    expect(describeLocation(null, true)).toContain('could not be worked out');
    expect(describeLocation(null)).not.toMatch(/AuraProjects/);
  });
});
