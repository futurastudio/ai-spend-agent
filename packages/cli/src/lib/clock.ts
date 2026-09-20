/** Workspace command clock. Tests inject the instant at the command boundary. */
export const workspaceClock = {
  now: (): string => new Date().toISOString(),
  daysBefore: (now: string, days: number): string => `${new Date(Date.parse(now) - days * 86400000).toISOString().slice(0, 10)}T00:00:00.000Z`,
};
