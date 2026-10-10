import type { ActOp, AskOp } from '../protocol/daemon-wire';
import type { AttachmentHost, ConfigHost, EditorContextHost, FileSearch, UpdateNotifyHost } from '../host/message-router';

type EditorContext = ReturnType<EditorContextHost['current']>;

export interface HookIo {
  act(op: ActOp, args: unknown[]): void;
  ask(op: AskOp, args: unknown[]): Promise<unknown>;
}

export function createRemoteHooks(io: HookIo) {
  let ctx: EditorContext = null;
  const editor: EditorContextHost = {
    current: () => ctx,
    reveal: (path, line) => io.act('reveal', [path, line]),
    openDiff: (root, path, base) => io.act('openDiff', [root, path, base]),
    openSettings: (section) => io.act('openSettings', [section]),
    openExternal: (url) => io.act('openExternal', [url]),
    exportCsv: (csv) => io.act('exportCsv', [csv]),
    exportImage: (uri) => io.act('exportImage', [uri]),
    login: (providerId) => io.act('login', [providerId]),
  };
  const picker: AttachmentHost = {
    pick: async () => {
      try {
        const r = await io.ask('pick', []);
        return Array.isArray(r) ? (r as string[]) : [];
      } catch { return []; }
    },
  };
  const fileSearch: FileSearch = {
    search: async (query) => {
      try {
        const r = await io.ask('search', [query]);
        return Array.isArray(r) ? (r as Awaited<ReturnType<FileSearch['search']>>) : [];
      } catch { return []; }
    },
  };
  const configHost: ConfigHost = { setFavoriteModels: (ids) => io.act('setFavoriteModels', [ids]) };
  const updateNotify: UpdateNotifyHost = {
    notify: (name, current, latest) => io.act('notify', ['info', `${name} ${current} → ${latest} available.`]),
  };
  return { editor, picker, fileSearch, configHost, updateNotify, setContext: (c: EditorContext) => { ctx = c; } };
}
