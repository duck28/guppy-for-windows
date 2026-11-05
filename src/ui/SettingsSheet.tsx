import { X } from "lucide-react";
import { useEffect, type ReactNode } from "react";
import { backend } from "../model/backend";
import { useModel } from "../model/GuppyModel";

/** Settings, in a sheet over the main window. */
export function SettingsSheet() {
  const model = useModel();
  const { tools } = model;
  const dismiss = () => model.setShowSettings(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        dismiss();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && dismiss()}>
      <div className="sheet" role="dialog" aria-labelledby="settings-title">
        <header className="sheet-header">
          <h2 id="settings-title">Settings</h2>
          <button className="icon-button" title="Close" aria-label="Close" onClick={dismiss}><X size={16} /></button>
        </header>

        <Section title="Downloads">
          <Row label="Save to">
            <span className="path" title={model.folder}>{model.folder}</span>
            <button className="button small" onClick={() => void model.chooseFolder()}>Change…</button>
          </Row>
          <Row label="Add cover art, title and chapters">
            <Switch on={model.settings.embedMetadata} onChange={(on) => model.set("embedMetadata", on)} />
          </Row>
        </Section>

        <Section title="Tools">
          <Row label="yt-dlp">
            <span className="secondary" title={tools?.ytdlp?.path}>
              {model.isCheckingTools ? "Looking…" : tools?.ytdlp ? tools.ytdlp.version : "Not installed"}
            </span>
            <button className="button small" disabled={!model.canUpdateTools}
                    onClick={tools?.ytdlp ? model.updateYtdlp : model.installTools}>
              {tools?.ytdlp ? "Update" : "Install"}
            </button>
          </Row>
          <Row label="FFmpeg">
            <span className="secondary" title={tools?.ffmpeg?.path}>
              {model.isCheckingTools ? "Looking…" : tools?.ffmpeg ? shortVersion(tools.ffmpeg.version) : "Not installed"}
            </span>
            {!tools?.ffmpeg && (
              <button className="button small" disabled={!model.canUpdateTools} onClick={model.installTools}>Install</button>
            )}
          </Row>
          {model.toolInstall && (
            <div className="row footnote">Downloading {model.toolInstall.tool}… {Math.round(model.toolInstall.fraction * 100)} %</div>
          )}
          {model.toolError && <div className="row footnote error-text">{model.toolError}</div>}
          <div className="row footnote">
            Guppy uses the newest yt-dlp it finds on this PC, or keeps its own copy in{" "}
            <button className="link-button inline" onClick={() => void backend.openPath(model.toolsFolder)}>its tools folder</button>.
            YouTube changes often; when downloads start failing, updating yt-dlp usually fixes it.
          </div>
        </Section>

        <p className="about caption secondary">
          <img src="/logo.svg" alt="" width={16} height={16} />
          Guppy 1.0 · Downloads with yt-dlp, converts with FFmpeg. Only download what you have the right to.
        </p>
      </div>
    </div>
  );
}

/** "N-127043-g5a54fcf75e-20251012" → "N-127043"; release builds ("7.1") stay as they are. */
function shortVersion(version: string) {
  return version.split("-").slice(0, 2).join("-") || version;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="form-section">
      <h3>{title}</h3>
      <div className="form-box">{children}</div>
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="row">
      <span>{label}</span>
      <span className="value">{children}</span>
    </div>
  );
}

function Switch({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  return <button role="switch" aria-checked={on} className={`switch${on ? " on" : ""}`} onClick={() => onChange(!on)} />;
}
