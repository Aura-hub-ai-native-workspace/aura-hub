/**
 * addedProject — which project a just-added folder became.
 *
 * "Add project" must make the folder the person picked the active project.
 * Picking the newest entry by list position is not the same thing: the list
 * is ordered by other fields, so the folder just added can be anywhere in it.
 * Matching on the folder's path is what identifies it.
 */
export interface RegisteredProject {
  id: string;
  path: string;
}

function normalise(path: string): string {
  return path.trim().replace(/\/+$/, '');
}

export function findAddedProject(
  projects: readonly RegisteredProject[],
  addedPath: string,
): RegisteredProject | null {
  const wanted = normalise(addedPath);
  return projects.find((p) => normalise(p.path) === wanted) ?? null;
}
