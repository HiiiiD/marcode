import * as vscode from 'vscode';
import type { SessionManager } from './session-manager';
import type { PostClient } from './post-bus';
import { Notifier, type NotifyKind } from './notifier';
import { focusSession } from './focus-session';
import { flashTaskbar } from './taskbar-flash';
import { NOTIFICATIONS_SETTING, validateNotificationKinds } from '../shared/notification-settings';
import { leafSessionIds } from '../webview/components/layout-tree';
import type { SessionId } from '../protocol/messages';

const TEXT: Record<NotifyKind, (name: string) => string> = {
  approval: (n) => `${n} needs a tool approval.`,
  question: (n) => `${n} has a question for you.`,
  finished: (n) => `${n} finished its turn.`,
  error: (n) => `${n} hit an error.`,
};

function readSettings() {
  const result = validateNotificationKinds(vscode.workspace.getConfiguration().get<unknown>(NOTIFICATIONS_SETTING));
  if (result.warnings.length > 0) { console.warn(result.warnings.join(' ')); }
  return result;
}

export function createNotifierClient(
  manager: SessionManager,
  isViewVisible: () => boolean,
): { client: PostClient; dispose(): void } {
  const badge = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  badge.command = 'workbench.view.extension.mar-code';

  const notifier = new Notifier({
    isWatching: (id) => vscode.window.state.focused && isViewVisible()
      && leafSessionIds(manager.layout().root).includes(id),
    nameOf: (id) => manager.summaries().find((s) => s.id === id)?.name ?? id,
    kinds: () => readSettings().kinds,
    waitingOn: (id) => manager.get(id)?.waitingOn() ?? 'approval',
    show: (id, kind, name) => {
      if (!vscode.window.state.focused && readSettings().taskbarFlash) {
        flashTaskbar(vscode.workspace.name ?? '');
      }
      const show = kind === 'error' ? vscode.window.showErrorMessage
        : kind === 'approval' || kind === 'question' ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
      void Promise.resolve(show(TEXT[kind](name), 'Show')).then(
        (pick) => { if (pick === 'Show') { return focusSession(manager, id); } },
        () => undefined,
      );
    },
    setPendingCount: (count) => {
      if (count === 0) { badge.hide(); return; }
      badge.text = `$(bell) ${count}`;
      badge.tooltip = `${count} session${count === 1 ? '' : 's'} waiting on you`;
      badge.show();
    },
  });

  const client: PostClient = {
    wants: (msg) => msg.t === 'session-status' || msg.t === 'sessions-changed',
    post: (msg) => {
      if (msg.t === 'session-status') { notifier.onStatus(msg.id as SessionId, msg.status); }
      else if (msg.t === 'sessions-changed') { notifier.retain(msg.sessions.map((s) => s.id)); }
    },
  };
  return { client, dispose: () => badge.dispose() };
}
