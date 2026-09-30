import { MOVED_SETTING_IDS } from './host-config';

/** The webview names a settings section by id; ids that now live in `config.json` open that file instead. */
export function routeOpenSettings(section: string): 'config-file' | 'vscode' {
  return section.split(/\s+/).some((id) => MOVED_SETTING_IDS.includes(id)) ? 'config-file' : 'vscode';
}
