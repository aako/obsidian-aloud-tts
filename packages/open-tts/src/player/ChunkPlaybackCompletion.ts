/**
 * Decide whether the media clock has actually reached the end of a chunk.
 * Do not equate a stopped clock or elapsed wall time with completed playback.
 * This cannot detect a platform media clock that advances while audio is silent.
 */
export function hasReachedChunkEnd(
  currentTime: number,
  timelineEndSeconds: number | null | undefined,
  textIsPlaying: boolean,
  audioIsPlaying: boolean,
): boolean {
  return (
    textIsPlaying &&
    audioIsPlaying &&
    Number.isFinite(currentTime) &&
    timelineEndSeconds != null &&
    Number.isFinite(timelineEndSeconds) &&
    currentTime >= timelineEndSeconds - 0.1
  );
}
