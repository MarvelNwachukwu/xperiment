// Pure cap-meter helpers. Reading the JSON logs happens in console.ts (impure);
// the counting stays pure and tested.
export function countToday(timestamps: string[], nowISO: string): number {
  const day = nowISO.slice(0, 10);
  return timestamps.filter((t) => typeof t === "string" && t.slice(0, 10) === day).length;
}

export function capLabel(used: number, max: number): string {
  return `${used}/${max}`;
}
