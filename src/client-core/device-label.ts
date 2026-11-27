const pad = (n: number): string => String(n).padStart(2, '0');

/** "PC-desk · online", or "PC-desk · offline, last seen 14:32" (with the date when it was not today). */
export function deviceLabel(device: { deviceName: string; online: boolean; lastSeenAt: number }, now = Date.now()): string {
  if (device.online) { return `${device.deviceName} · online`; }
  if (device.lastSeenAt <= 0) { return `${device.deviceName} · offline`; }
  const seen = new Date(device.lastSeenAt);
  const today = new Date(now);
  const time = `${pad(seen.getHours())}:${pad(seen.getMinutes())}`;
  const sameDay = seen.getFullYear() === today.getFullYear() && seen.getMonth() === today.getMonth() && seen.getDate() === today.getDate();
  const when = sameDay ? time : `${seen.getFullYear()}-${pad(seen.getMonth() + 1)}-${pad(seen.getDate())} ${time}`;
  return `${device.deviceName} · offline, last seen ${when}`;
}
