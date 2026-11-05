// The window this interface runs in. Guppy draws its own title bar, so it needs minimize, maximize and close
// itself. In the browser preview these do nothing.

import { isTauri } from "./backend";

type Unlisten = () => void;

export interface AppWindow {
  minimize(): void;
  toggleMaximize(): void;
  isMaximized(): Promise<boolean>;
  onResized(handler: () => void): Promise<Unlisten>;
  /** Asks to close; `onCloseRequested` may veto it. */
  close(): void;
  onCloseRequested(handler: () => Promise<boolean>): Promise<Unlisten>;
  onFocus(handler: () => void): Promise<Unlisten>;
}

async function makeTauriWindow(): Promise<AppWindow> {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const current = getCurrentWindow();
  return {
    minimize: () => void current.minimize(),
    toggleMaximize: () => void current.toggleMaximize(),
    isMaximized: () => current.isMaximized(),
    onResized: (handler) => current.onResized(handler),
    close: () => void current.close(),
    onCloseRequested: (handler) =>
      current.onCloseRequested(async (event) => {
        event.preventDefault();
        if (await handler()) await current.destroy();
      }),
    onFocus: (handler) => current.onFocusChanged(({ payload: focused }) => focused && handler()),
  };
}

function makePreviewWindow(): AppWindow {
  return {
    minimize: () => {},
    toggleMaximize: () => {},
    isMaximized: async () => false,
    onResized: async () => () => {},
    close: () => window.close(),
    onCloseRequested: async () => () => {},
    onFocus: async (handler) => {
      window.addEventListener("focus", handler);
      return () => window.removeEventListener("focus", handler);
    },
  };
}

export const appWindow: AppWindow = isTauri ? await makeTauriWindow() : makePreviewWindow();
