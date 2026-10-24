/**
 * Obsidian emits rename events for both note files and folders.
 * Match only the exact old path or its slash-delimited descendants.
 * Audio/cache hashes are deliberately not modified.
 */
export function relocatedVaultPath(
  originalPath: string,
  oldPath: string,
  newPath: string,
): string {
  if (!oldPath || !newPath || oldPath === newPath) return originalPath;
  if (originalPath === oldPath) return newPath;
  return originalPath.startsWith(`${oldPath}/`)
    ? `${newPath}${originalPath.slice(oldPath.length)}`
    : originalPath;
}
