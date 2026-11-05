import {
  AudioLines, ChevronDown, CircleAlert, ClipboardPaste, Download, FileAudio, Film, FolderOpen, ListVideo, LoaderCircle,
  Music, Play, RotateCw, Settings as SettingsIcon, Trash2, Wrench, X,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { isTauri } from "../model/backend";
import { formatDuration, useModel, type GuppyModel, type Job } from "../model/GuppyModel";
import { AUDIO_FORMATS, BITRATES, CONTAINERS, heightTitle } from "../model/settings";
import { item, MenuButton } from "./Menu";
import { SettingsSheet } from "./SettingsSheet";
import { TitleBar } from "./TitleBar";

export function ContentView() {
  const model = useModel();
  const [isDropTargeted, setDropTargeted] = useState(false);
  useFileDrop(model, setDropTargeted);

  return (
    <div className="window">
      <TitleBar>
        <button className="toolbar-button" title="Settings" aria-label="Settings" onClick={() => model.setShowSettings(true)}>
          <SettingsIcon size={16} />
        </button>
      </TitleBar>

      <main className="content">
        <ToolsNotice model={model} />
        <LinkField model={model} />
        {model.fetchError && <p className="field-error"><CircleAlert size={14} />{model.fetchError}</p>}
        {model.isFetching && <PreviewSkeleton />}
        {model.info && <Preview model={model} />}
        {model.jobs.length > 0 ? <Queue model={model} /> : !model.info && !model.isFetching && <EmptyState model={model} />}
      </main>

      {isDropTargeted && (
        <div className="drop-highlight">
          <span className="drop-label"><AudioLines size={18} />Drop to convert to {model.settings.audioFormat.toUpperCase()}</span>
        </div>
      )}
      {model.showSettings && <SettingsSheet />}
      {model.dialog && <AlertView model={model} />}
    </div>
  );
}

// MARK: - Tools

function ToolsNotice({ model }: { model: GuppyModel }) {
  const install = model.toolInstall;
  if (install) {
    return (
      <div className="notice">
        <LoaderCircle size={18} className="spin accent" />
        <div className="notice-body">
          <span>Downloading {install.tool}… {Math.round(install.fraction * 100)} %</span>
          <ProgressBar value={install.fraction} />
        </div>
      </div>
    );
  }
  const missing = model.missingTools;
  if (missing.length > 0) {
    return (
      <div className="notice">
        <Wrench size={18} className="accent" />
        <div className="notice-body">
          <strong>One-time setup</strong>
          <span className="secondary">
            Guppy downloads with yt-dlp and converts with FFmpeg. It can get {missing.join(" and ")} for you and keep
            {missing.length > 1 ? " them" : " it"} in its own folder (about {missing.includes("FFmpeg") ? "150" : "20"} MB).
          </span>
          {model.toolError && <span className="error-text">{model.toolError}</span>}
        </div>
        <button className="button prominent" onClick={model.installTools}>Set Up</button>
      </div>
    );
  }
  if (model.tools?.ytdlpOutdated) {
    return (
      <div className="notice">
        <CircleAlert size={18} className="accent" />
        <div className="notice-body">
          <span>yt-dlp {model.tools.ytdlp?.version} is out of date, and YouTube regularly breaks older versions.</span>
          {model.toolError && <span className="error-text">{model.toolError}</span>}
        </div>
        <button className="button" disabled={!model.canUpdateTools} onClick={model.updateYtdlp}>Update</button>
      </div>
    );
  }
  return null;
}

// MARK: - Link

function LinkField({ model }: { model: GuppyModel }) {
  const field = useRef<HTMLInputElement>(null);
  const hasText = model.link.trim() !== "";
  const disabled = !model.canDownload;

  useEffect(() => {
    if (!disabled) field.current?.focus();
  }, [disabled]);

  return (
    <form className={`link-field${disabled ? " disabled" : ""}`}
          onSubmit={(e) => {
            e.preventDefault();
            void model.fetch();
          }}>
      <ListVideo size={18} className="link-icon" />
      <input ref={field} value={model.link} disabled={disabled} spellCheck={false} aria-label="Video link"
             placeholder="Paste a YouTube link"
             onChange={(e) => model.setLink(e.target.value)}
             onPaste={(e) => {
               // Look the link up right away when it replaces everything in the field.
               const pasted = e.clipboardData.getData("text").trim();
               const input = e.currentTarget;
               if (pasted && input.selectionStart === 0 && input.selectionEnd === input.value.length) {
                 e.preventDefault();
                 model.setLink(pasted);
                 void model.fetch();
               }
             }} />
      {hasText && !model.isFetching && (
        <button type="button" className="icon-button" title="Clear" aria-label="Clear" onClick={() => model.clearLink()}>
          <X size={15} />
        </button>
      )}
      {hasText
        ? <button type="submit" className="button prominent" disabled={disabled || model.isFetching}>
            {model.isFetching ? <LoaderCircle size={15} className="spin" /> : "Go"}
          </button>
        : <button type="button" className="button" disabled={disabled} onClick={() => void model.pasteAndFetch()}>
            <ClipboardPaste size={15} />Paste
          </button>}
    </form>
  );
}

function PreviewSkeleton() {
  return (
    <div className="card preview loading" aria-label="Loading">
      <div className="thumbnail shimmer" />
      <div className="preview-text">
        <div className="shimmer line" style={{ width: "70%" }} />
        <div className="shimmer line" style={{ width: "40%" }} />
      </div>
    </div>
  );
}

function Thumbnail({ src, className, fallback }: { src: string | null; className: string; fallback: ReactNode }) {
  const [failed, setFailed] = useState(false);
  return (
    <div className={className}>
      {src && !failed ? <img src={src} alt="" onError={() => setFailed(true)} /> : fallback}
    </div>
  );
}

function Preview({ model }: { model: GuppyModel }) {
  const info = model.info!;
  const { mode, maxHeight, container, audioFormat, audioBitrate } = model.settings;
  const duration = info.isPlaylist ? null : info.entries[0]?.duration;
  const format = AUDIO_FORMATS.find((f) => f.id === audioFormat)!;

  return (
    <section className="card">
      <div className="preview">
        <Thumbnail src={info.thumbnail} className="thumbnail" fallback={<Film size={24} />} />
        <div className="preview-text">
          <h2 title={info.title}>{info.title}</h2>
          <span className="secondary">
            {[info.channel, info.isPlaylist ? `Playlist · ${info.entries.length} videos` : null,
              duration ? formatDuration(duration) : null].filter(Boolean).join(" · ")}
          </span>
        </div>
      </div>

      <div className="options">
        <div className="segmented" role="radiogroup" aria-label="Download">
          <button role="radio" aria-checked={mode === "video"} className={mode === "video" ? "selected" : ""}
                  onClick={() => model.set("mode", "video")}><Film size={14} />Video</button>
          <button role="radio" aria-checked={mode === "audio"} className={mode === "audio" ? "selected" : ""}
                  onClick={() => model.set("mode", "audio")}><Music size={14} />Audio</button>
        </div>

        {mode === "video" ? (
          <>
            <PopUp label="Quality" value={heightTitle(maxHeight)}
                   entries={model.offeredHeights.map((h) => ({
                     title: heightTitle(h), checked: h === maxHeight, action: () => model.set("maxHeight", h),
                   }))} />
            <PopUp label="Format" value={CONTAINERS.find((c) => c.id === container)!.title}
                   entries={CONTAINERS.map((c) => ({
                     title: c.title, checked: c.id === container, action: () => model.set("container", c.id),
                   }))} />
          </>
        ) : (
          <>
            <PopUp label="Format" value={format.title}
                   entries={AUDIO_FORMATS.map((f) => ({
                     title: f.title, checked: f.id === audioFormat, action: () => model.set("audioFormat", f.id),
                   }))} />
            {format.lossless
              ? <span className="pill">Lossless</span>
              : <PopUp label="Quality" value={`${audioBitrate} kbps`}
                       entries={BITRATES.map((b) => ({
                         title: `${b} kbps`, checked: b === audioBitrate, action: () => model.set("audioBitrate", b),
                       }))} />}
          </>
        )}

        <button className="button prominent large download-button" disabled={!model.canDownload}
                onClick={() => model.download()}>
          <Download size={16} />{info.isPlaylist ? `Download ${info.entries.length}` : "Download"}
        </button>
      </div>
    </section>
  );
}

function PopUp({ label, value, entries }: {
  label: string;
  value: string;
  entries: { title: string; checked: boolean; action: () => void }[];
}) {
  return (
    <MenuButton className="popup" ariaLabel={label} title={label}
                label={<><span className="popup-label">{label}</span><span>{value}</span><ChevronDown size={13} /></>}
                entries={() => entries.map((e) => item(e.title, e.action, { checked: e.checked }))} />
  );
}

// MARK: - Queue

function Queue({ model }: { model: GuppyModel }) {
  const active = model.jobs.filter((j) => j.status === "running" || j.status === "waiting").length;
  return (
    <section className="queue">
      <header className="queue-header">
        <h3>Downloads{active > 0 && <span className="count">{active}</span>}</h3>
        <button className="link-button" onClick={() => model.openFolder()}><FolderOpen size={14} />{model.folderName}</button>
        {model.hasFinishedJobs && (
          <button className="link-button" onClick={() => model.clearFinished()}><Trash2 size={14} />Clear finished</button>
        )}
      </header>
      <ul className="jobs">
        {model.jobs.map((job) => <JobRow key={job.id} model={model} job={job} />)}
      </ul>
    </section>
  );
}

function JobRow({ model, job }: { model: GuppyModel; job: Job }) {
  const isConvert = job.task.kind === "convert";
  const fraction = job.progress?.fraction ?? null;
  return (
    <li className={`job ${job.status}`}>
      <Thumbnail src={job.thumbnail} className="job-thumbnail"
                 fallback={isConvert ? <FileAudio size={18} /> : <Film size={18} />} />
      <div className="job-text">
        <div className="job-title">
          <span className="title" title={job.title}>{job.title}</span>
          <span className="badge">{job.formatTitle}</span>
        </div>
        <span className={`job-status${job.status === "failed" ? " error-text" : " secondary"}`} title={model.statusText(job)}>
          {model.statusText(job)}
        </span>
        {job.status === "running" && <ProgressBar value={fraction} />}
      </div>
      <div className="job-actions">
        {(job.status === "running" || job.status === "waiting") && (
          <IconButton title="Cancel" onClick={() => model.cancel(job)}><X size={15} /></IconButton>
        )}
        {job.status === "done" && (
          <>
            <IconButton title="Play" onClick={() => model.open(job)}><Play size={15} /></IconButton>
            <IconButton title="Show in Explorer" onClick={() => model.reveal(job)}><FolderOpen size={15} /></IconButton>
          </>
        )}
        {(job.status === "failed" || job.status === "cancelled") && (
          <IconButton title="Try Again" onClick={() => model.retry(job)}><RotateCw size={15} /></IconButton>
        )}
        {job.status !== "running" && job.status !== "waiting" && (
          <IconButton title="Remove from List" onClick={() => model.remove(job)}><Trash2 size={15} /></IconButton>
        )}
      </div>
    </li>
  );
}

function IconButton({ title, onClick, children }: { title: string; onClick: () => void; children: ReactNode }) {
  return <button className="icon-button" title={title} aria-label={title} onClick={onClick}>{children}</button>;
}

/** A thin bar; null shows a moving stripe while the amount is unknown. */
export function ProgressBar({ value }: { value: number | null }) {
  return (
    <div className={`progress${value === null ? " indeterminate" : ""}`} role="progressbar"
         aria-valuemin={0} aria-valuemax={100} aria-valuenow={value === null ? undefined : Math.round(value * 100)}>
      <div style={value === null ? undefined : { width: `${Math.min(Math.max(value, 0), 1) * 100}%` }} />
    </div>
  );
}

// MARK: - Empty state

function EmptyState({ model }: { model: GuppyModel }) {
  return (
    <div className="empty">
      <img src="/logo.svg" alt="" width={112} height={112} />
      <h2>Paste a link to get started</h2>
      <p className="secondary">
        Download YouTube videos in up to 4K, or just their audio as MP3, M4A, Opus, FLAC or WAV.
      </p>
      <p className="secondary caption">
        Converting a file? Drop it here, or{" "}
        <button className="link-button inline" onClick={() => void model.chooseFilesToConvert()}>choose files</button>.
      </p>
    </div>
  );
}

// MARK: - Alerts and drops

function AlertView({ model }: { model: GuppyModel }) {
  const dialog = model.dialog!;
  const defaultButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    defaultButton.current?.focus();
    const cancelIndex = dialog.buttons.findIndex((b) => b.role === "cancel");
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        dialog.answer(cancelIndex >= 0 ? cancelIndex : 0);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [dialog]);

  return (
    <div className="scrim centered">
      <div className="alert" role="alertdialog" aria-labelledby="alert-message">
        <img src="/logo.svg" alt="" />
        <h2 id="alert-message">{dialog.message}</h2>
        <p>{dialog.information}</p>
        <div className="alert-buttons">
          {dialog.buttons.map((button, index) => (
            <button key={index} ref={button.role === "default" ? defaultButton : undefined}
                    className={`button large${button.role === "default" ? " prominent" : ""}`}
                    onClick={() => dialog.answer(index)}>
              {button.title}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function useFileDrop(model: GuppyModel, setTargeted: (targeted: boolean) => void) {
  useEffect(() => {
    if (!isTauri) return;
    let unlisten: (() => void) | undefined;
    void import("@tauri-apps/api/webview").then(({ getCurrentWebview }) =>
      getCurrentWebview().onDragDropEvent((event) => {
        const payload = event.payload;
        if (payload.type === "enter" || payload.type === "over") {
          setTargeted(model.tools?.ffmpeg != null);
        } else if (payload.type === "drop") {
          setTargeted(false);
          if (model.tools?.ffmpeg) model.convertFiles(payload.paths);
        } else {
          setTargeted(false);
        }
      }).then((f) => (unlisten = f)));
    return () => unlisten?.();
  }, [model, setTargeted]);
}
