export const selectLatestNativeAudioStatus = (
  current: NativeAudioStatus | undefined,
  candidate: NativeAudioStatus,
): NativeAudioStatus => {
  if (!current) return candidate;

  const currentRevision = current.revision ?? -1;
  const candidateRevision = candidate.revision ?? -1;
  return candidateRevision >= currentRevision ? candidate : current;
};
