export const NOTIFICATIONS_SETTING = 'marcode.notifications';

export interface NotificationKinds { approval: boolean; question: boolean; finished: boolean; error: boolean }
export interface NotificationValidation { kinds: NotificationKinds; taskbarFlash: boolean; warnings: string[] }

const KEYS: readonly (keyof NotificationKinds)[] = ['approval', 'question', 'finished', 'error'];

export function validateNotificationKinds(configured: unknown): NotificationValidation {
  const kinds: NotificationKinds = { approval: true, question: true, finished: true, error: true };
  if (configured === undefined) { return { kinds, taskbarFlash: true, warnings: [] }; }
  if (typeof configured !== 'object' || configured === null || Array.isArray(configured)) {
    return { kinds, taskbarFlash: true, warnings: [`${NOTIFICATIONS_SETTING} is not an object; ignoring it.`] };
  }
  const value = configured as Record<string, unknown>;
  const warnings: string[] = [];
  const flag = (key: string, into: (v: boolean) => void): void => {
    if (value[key] === undefined) { return; }
    if (typeof value[key] === 'boolean') { into(value[key] as boolean); }
    else { warnings.push(`${NOTIFICATIONS_SETTING}.${key} must be a boolean; using true.`); }
  };
  for (const key of KEYS) { flag(key, (v) => { kinds[key] = v; }); }
  let taskbarFlash = true;
  flag('taskbarFlash', (v) => { taskbarFlash = v; });
  return { kinds, taskbarFlash, warnings };
}
