import type { ClientHooks } from '../daemon-client/daemon-client';
import type { AttachmentHost, ConfigHost, EditorContextHost, FileSearch } from './message-router';

export interface HookSet {
  editor: EditorContextHost;
  picker: AttachmentHost;
  fileSearch: FileSearch;
  configHost: ConfigHost;
}

export interface Notices {
  info(text: string): void;
  warn(text: string): void;
  shellNoise(profile: string): void;
}

/** Adapts the client-local hooks to what a `DaemonClient` calls when the daemon asks for work. */
export function hooksToClient(set: HookSet, notice: Notices): Pick<ClientHooks, 'act' | 'ask'> {
  return {
    act: (op, args) => {
      if (op === 'setFavoriteModels') { set.configHost.setFavoriteModels(args[0] as string[]); return; }
      if (op === 'notify') { (args[0] === 'warn' ? notice.warn : notice.info)(String(args[1])); return; }
      if (op === 'shellNoise') { notice.shellNoise(String(args[0])); return; }
      (set.editor[op] as (...a: unknown[]) => void)(...args);
    },
    ask: async (op, args) => (op === 'pick' ? set.picker.pick() : set.fileSearch.search(String(args[0] ?? ''))),
  };
}
