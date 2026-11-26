export function hostOf(server: string): string {
  try { return new URL(server).host; } catch { return server; }
}

export function lastSeen(at: number, now: number): string {
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) { return 'just now'; }
  if (minutes < 60) { return `${minutes} min ago`; }
  const hours = Math.floor(minutes / 60);
  if (hours < 48) { return `${hours} h ago`; }
  return `${Math.floor(hours / 24)} days ago`;
}

export function countdown(expiresAt: number, now: number): string {
  const left = Math.ceil((expiresAt - now) / 1000);
  if (left <= 0) { return ''; }
  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
}

export function middleTruncate(text: string, max: number): string {
  if (text.length <= max) { return text; }
  const keep = max - 1;
  const head = Math.ceil(keep / 2);
  return `${text.slice(0, head)}…${text.slice(text.length - (keep - head))}`;
}

export function codeGroups(code: string): string[] {
  return code.split('-').filter(Boolean);
}
