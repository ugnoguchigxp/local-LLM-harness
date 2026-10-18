/** The release clock advances on successful new demand and foreground activity. */
export function agentConnectionIdleDeadline(
  activity: { createdAt: string; readyAt?: string; lastForegroundActivityAt?: string; lastProfileRequestAt?: string },
  idleSeconds: number,
): number {
  return Math.max(...[
    activity.createdAt, activity.readyAt, activity.lastForegroundActivityAt, activity.lastProfileRequestAt,
  ].filter((value): value is string => value !== undefined).map(Date.parse)) + idleSeconds * 1_000;
}
