import type { ConfigHost, EditorContextHost } from '../host/message-router';

export function terminalEditorHost(onLogin: (providerId: string) => void): EditorContextHost {
  return {
    current: () => null,
    reveal: () => {},
    openDiff: () => {},
    openSettings: () => {},
    openExternal: () => {},
    exportCsv: () => {},
    exportImage: () => {},
    login: onLogin,
  };
}

export function terminalConfigHost(setFavorites: (ids: string[]) => void): ConfigHost {
  return { setFavoriteModels: setFavorites };
}
