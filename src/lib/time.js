export const now = () => new Date().toISOString();

export function addMinutes(date, minutes) {
  return new Date(new Date(date).getTime() + minutes * 60_000).toISOString();
}

export function addHours(date, hours) {
  return addMinutes(date, hours * 60);
}
