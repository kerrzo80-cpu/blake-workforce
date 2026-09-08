/** Parse a 24-hour clock value; never silently treat invalid input as midnight. */
export function minutesFromClock(value: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

export function scheduledMinutes(value: string): number {
  const parts = value.split(/[-–]/);
  if (parts.length !== 2) return 0;
  const start = minutesFromClock(parts[0]);
  const finish = minutesFromClock(parts[1]);
  return start !== null && finish !== null && finish > start ? finish - start : 0;
}
