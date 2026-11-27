const pad = (n: number): string => String(n).padStart(2, '0');

/** `14:32` today, otherwise `2026-11-25 09:05`. */
export function seenAt(ts: number, now = Date.now()): string {
  const seen = new Date(ts);
  const today = new Date(now);
  const time = `${pad(seen.getHours())}:${pad(seen.getMinutes())}`;
  const sameDay = seen.getFullYear() === today.getFullYear() && seen.getMonth() === today.getMonth() && seen.getDate() === today.getDate();
  return sameDay ? time : `${seen.getFullYear()}-${pad(seen.getMonth() + 1)}-${pad(seen.getDate())} ${time}`;
}

/** "PC-desk · online", or "PC-desk · offline, last seen 14:32" (with the date when it was not today). */
export function deviceLabel(device: { deviceName: string; online: boolean; lastSeenAt: number }, now = Date.now()): string {
  if (device.online) { return `${device.deviceName} · online`; }
  if (device.lastSeenAt <= 0) { return `${device.deviceName} · offline`; }
  return `${device.deviceName} · offline, last seen ${seenAt(device.lastSeenAt, now)}`;
}
