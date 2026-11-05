import { Copy, Minus, Square, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { appWindow } from "../model/appWindow";

/** The window's title bar: the logo and name on the left, `children` and the Windows caption buttons on the right. */
export function TitleBar({ children }: { children?: ReactNode }) {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    const update = () => void appWindow.isMaximized().then(setMaximized);
    update();
    const unlisten = appWindow.onResized(update);
    return () => void unlisten.then((f) => f());
  }, []);

  return (
    <header className="titlebar" data-tauri-drag-region>
      <div className="brand" data-tauri-drag-region>
        <img src="/logo.svg" alt="" width={22} height={22} />
        <strong>Guppy</strong>
      </div>
      {children}
      <div className="caption-buttons">
        <button className="caption-button" aria-label="Minimize" title="Minimize" onClick={appWindow.minimize}>
          <Minus size={15} strokeWidth={1.25} />
        </button>
        <button className="caption-button" aria-label={maximized ? "Restore" : "Maximize"}
                title={maximized ? "Restore Down" : "Maximize"} onClick={appWindow.toggleMaximize}>
          {maximized ? <Copy size={12} strokeWidth={1.25} style={{ transform: "scaleX(-1)" }} />
                     : <Square size={12} strokeWidth={1.25} />}
        </button>
        <button className="caption-button close" aria-label="Close" title="Close" onClick={appWindow.close}>
          <X size={16} strokeWidth={1.25} />
        </button>
      </div>
    </header>
  );
}
