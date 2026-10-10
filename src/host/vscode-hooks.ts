import * as vscode from 'vscode';
import {
  exportCsv, exportImage, openExternal, openFileDiff, openLoginTerminal, revealFile,
} from './editor-actions';
import type { HookSet } from './act-adapter';
import type { AttachmentHost, ConfigHost, EditorContextHost, FileSearch, UpdateNotifyHost } from './message-router';
import { routeOpenSettings } from './settings-routing';
import type { EditorContext } from '../providers/types';

export interface LoginRecipeLookup {
  get(id: string): { terminalName: string; command: string; env?: NodeJS.ProcessEnv } | undefined;
}

export interface VscodeHooksDeps {
  configFile: string;
  loginRecipes: () => LoginRecipeLookup;
  fileSearch: FileSearch;
  favorites: { set(ids: string[]): Promise<void> };
  tracker: { readonly current: EditorContext | null };
}

export function createVscodeHooks(deps: VscodeHooksDeps): HookSet & { updateNotify: UpdateNotifyHost } {
  const editor: EditorContextHost = {
    current: () => deps.tracker.current,
    reveal: (target, startLine) => { void revealFile(target, startLine); },
    openDiff: (root, target, base) => { void openFileDiff(root, target, base); },
    openSettings: (section) => {
      if (routeOpenSettings(section) === 'config-file') {
        void vscode.commands.executeCommand('vscode.open', vscode.Uri.file(deps.configFile));
      } else {
        void vscode.commands.executeCommand('workbench.action.openSettings', section);
      }
    },
    openExternal: (url) => { void openExternal(url); },
    exportCsv: (csv) => { void exportCsv(csv); },
    exportImage: (dataUri) => { void exportImage(dataUri); },
    login: (providerId) => {
      // A provider with no recipe is a no-op: it has no login flow, or the id is stale.
      const recipe = deps.loginRecipes().get(providerId);
      if (recipe) { openLoginTerminal(recipe.terminalName, recipe.command, recipe.env); }
    },
  };

  const picker: AttachmentHost = {
    pick: async () => {
      const chosen = await vscode.window.showOpenDialog({ canSelectMany: true, openLabel: 'Attach' });
      return chosen?.map((uri) => uri.fsPath) ?? [];
    },
  };

  const configHost: ConfigHost = { setFavoriteModels: (ids) => { void deps.favorites.set(ids); } };

  // Per activation, keyed on provider: the sidebar re-posts `ready` on every reveal and a stale
  // binary would otherwise re-show the same toast each time.
  const notified = new Set<string>();
  const updateNotify: UpdateNotifyHost = {
    notify: (displayName, current, latest) => {
      if (notified.has(displayName)) { return; }
      notified.add(displayName);
      void vscode.window.showInformationMessage(`${displayName} ${current} → ${latest} available.`);
    },
  };

  return { editor, picker, fileSearch: deps.fileSearch, configHost, updateNotify };
}
