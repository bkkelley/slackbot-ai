export function resolveChannel(
  jobChannel: { platform: string; id: string } | undefined,
  defaultChannel: { platform: string; id: string } | undefined
): { platform: string; id: string } | null {
  return jobChannel ?? defaultChannel ?? null;
}
