/**
 * Never silently present a different article in the cache manager.
 * A single saved job for the current note is safe to preselect.
 * Multiple matches are ambiguous (selection range or voice can differ).
 */
export function selectCurrentArticleCacheJob<T extends { path: string }>(
  jobs: readonly T[],
  currentPath: string | undefined,
): T | undefined {
  if (!currentPath) return undefined;
  const matches = jobs.filter((job) => job.path === currentPath);
  return matches.length === 1 ? matches[0] : undefined;
}
