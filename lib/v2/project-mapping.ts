export type ProjectWithServerMapping = {
  id: string;
  serverProjectId?: string;
  photos?: { src?: string }[];
};

/** Extract the backend project namespace from a persisted material URL. */
export function materialProjectId(src: string | undefined): string | null {
  if (!src) return null;
  const match = src.match(/(?:^|\/)api\/v1\/projects\/([^/]+)\/materials\//);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

/**
 * Backfill old workspace docs and assign stable IDs to new UI projects.
 * Old versions used the first backend project for every upload, so only the
 * first unclaimed backend project is adopted as the legacy default. New
 * projects use their stable UI ID as the idempotency key for server creation.
 */
export function resolveProjectMappings<T extends ProjectWithServerMapping>(
  projects: T[],
  existingServerProjectIds: string[],
): (T & { serverProjectId: string })[] {
  const existing = new Set(existingServerProjectIds);
  const claimed = new Set<string>();
  const result = projects.map((project) => ({ ...project })) as (T & {
    serverProjectId?: string;
  })[];

  for (const project of result) {
    if (project.serverProjectId) claimed.add(project.serverProjectId);
  }

  // Assign the legacy default before inspecting later projects. In the old
  // workspace, a material reference in any UI project could point to this
  // same shared backend project; only the first project owns future uploads.
  const firstProject = result[0];
  const legacyDefault = existingServerProjectIds.find((id) => !claimed.has(id));
  if (firstProject && !firstProject.serverProjectId && legacyDefault) {
    firstProject.serverProjectId = legacyDefault;
    claimed.add(legacyDefault);
  }

  for (const project of result) {
    if (project.serverProjectId) continue;
    const referenced = new Set(
      (project.photos ?? [])
        .map((photo) => materialProjectId(photo.src))
        .filter((id): id is string => Boolean(id && existing.has(id))),
    );
    const matching = [...referenced].find((id) => !claimed.has(id));
    if (matching) {
      project.serverProjectId = matching;
      claimed.add(matching);
    }
  }

  for (const project of result) {
    if (!project.serverProjectId) project.serverProjectId = project.id;
  }
  return result as (T & { serverProjectId: string })[];
}
