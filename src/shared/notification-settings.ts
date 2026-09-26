export const NOTIFICATIONS_SETTING = 'marcode.notifications';

export interface NotificationKinds { approval: boolean; question: boolean; finished: boolean; error: boolean }
export interface NotificationValidation { kinds: NotificationKinds; warnings: string[] }

const KEYS: readonly (keyof NotificationKinds)[] = ['approval', 'question', 'finished', 'error'];

export function validateNotificationKinds(configured: unknown): NotificationValidation {
  const kinds: NotificationKinds = { approval: true, question: true, finished: true, error: true };
  if (configured === undefined) { return { kinds, warnings: [] }; }
  if (typeof configured !== 'object' || configured === null || Array.isArray(configured)) {
    return { kinds, warnings: [`${NOTIFICATIONS_SETTING} is not an object; ignoring it.`] };
  }
  const value = configured as Record<string, unknown>;
  const warnings: string[] = [];
  for (const key of KEYS) {
    if (value[key] === undefined) { continue; }
    if (typeof value[key] === 'boolean') { kinds[key] = value[key] as boolean; }
    else { warnings.push(`${NOTIFICATIONS_SETTING}.${key} must be a boolean; using true.`); }
  }
  return { kinds, warnings };
}
