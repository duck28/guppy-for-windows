// The app's state and behavior: the link being looked at, the download queue and the tools. The Rust backend
// runs yt-dlp and FFmpeg.

import { useSyncExternalStore } from "react";
import { appWindow } from "./appWindow";
import {
  backend, MEDIA_FILE_EXTENSIONS, type ConvertOptions, type DownloadOptions, type MediaInfo, type Progress, type Tools,
} from "./backend";
import { AUDIO_FORMATS, CONTAINERS, HEIGHTS, heightTitle, loadSettings, storeSetting, type Settings } from "./settings";

export type JobStatus = "waiting" | "running" | "done" | "failed" | "cancelled";

export interface Job {
  id: string;
  title: string;
  /** The channel, or the folder of a file being converted. */
  subtitle: string | null;
  thumbnail: string | null;
  /** "MP4 · 1080p", "MP3 · 320 kbps"… */
  formatTitle: string;
  task: { kind: "download"; options: DownloadOptions } | { kind: "convert"; options: ConvertOptions };
  status: JobStatus;
  progress: Progress | null;
  /** The saved file, once done. */
  file: string | null;
  error: string | null;
}

export interface DialogButton {
  title: string;
  role?: "default" | "cancel";
}

/** An alert waiting for an answer. */
export interface Dialog {
  message: string;
  information: string;
  buttons: DialogButton[];
  answer: (index: number) => void;
}

/** How many downloads and conversions run at the same time. */
const PARALLEL_JOBS = 2;

const lastPathComponent = (path: string) => path.split(/[\\/]/).pop() ?? path;
const deletingPathExtension = (name: string) => name.replace(/\.[^.\\/]*$/, "");
const pathExtension = (path: string) => /\.([^.\\/]*)$/.exec(path)?.[1]?.toLowerCase() ?? "";

const isCancellation = (error: unknown) => String(error) === "cancelled";

/** The link in `text`, if it is one (yt-dlp handles many sites besides YouTube). */
export function linkIn(text: string): string | null {
  try {
    const url = new URL(text.trim());
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

function isYouTubeLink(text: string) {
  const link = linkIn(text);
  if (!link) return false;
  const host = new URL(link).hostname.toLowerCase();
  return host === "youtu.be" || host === "youtube.com" || host.endsWith(".youtube.com");
}

export function formatDuration(seconds: number) {
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

function formatSpeed(bytesPerSecond: number) {
  if (bytesPerSecond >= 1_000_000) return `${(bytesPerSecond / 1_000_000).toFixed(1)} MB/s`;
  return `${Math.max(1, Math.round(bytesPerSecond / 1000))} KB/s`;
}

export class GuppyModel {
  // MARK: Link
  link = "";
  info: MediaInfo | null = null;
  isFetching = false;
  fetchError: string | null = null;
  /** Bumped by every lookup, so an older one that finishes late is ignored. */
  private fetchID = 0;
  /** The last link taken from the clipboard, so it isn't offered again after it's cleared. */
  private clipboardLink = "";

  // MARK: Queue
  jobs: Job[] = [];
  private nextJobID = 1;

  // MARK: Tools
  tools: Tools | null = null;
  isCheckingTools = true;
  /** The tool being downloaded and how far it is. */
  toolInstall: { tool: string; fraction: number } | null = null;
  toolError: string | null = null;

  settings: Settings = loadSettings();
  defaultFolder = "";
  showSettings = false;
  dialog: Dialog | null = null;

  // MARK: - Observation

  private version = 0;
  private listeners = new Set<() => void>();

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getVersion = () => this.version;

  private changed() {
    this.version++;
    this.listeners.forEach((listener) => listener());
  }

  // MARK: - Launch

  async launch() {
    void backend.listen<Progress & { id: string }>("job-progress", ({ id, ...progress }) => {
      const job = this.jobs.find((j) => j.id === id);
      if (job?.status !== "running") return;
      job.progress = progress;
      this.changed();
    });
    void backend.listen<{ tool: string; fraction: number }>("tools-progress", (progress) => {
      this.toolInstall = progress;
      this.changed();
    });
    void appWindow.onFocus(() => void this.offerClipboardLink());
    this.defaultFolder = await backend.defaultFolder();
    this.changed();
    await this.checkTools();
    void this.offerClipboardLink();
  }

  get folder() {
    return this.settings.folder || this.defaultFolder;
  }

  get canDownload() {
    return this.tools?.ytdlp != null && this.tools.ffmpeg != null;
  }

  get missingTools(): string[] {
    if (!this.tools) return [];
    return [this.tools.ytdlp ? null : "yt-dlp", this.tools.ffmpeg ? null : "FFmpeg"].filter((t): t is string => t !== null);
  }

  set<K extends keyof Settings>(key: K, value: Settings[K]) {
    this.settings = { ...this.settings, [key]: value };
    storeSetting(key, value);
    this.changed();
  }

  setShowSettings(show: boolean) {
    this.showSettings = show;
    this.changed();
  }

  // MARK: - Tools

  async checkTools() {
    this.isCheckingTools = true;
    this.changed();
    try {
      this.tools = await backend.findTools();
    } finally {
      this.isCheckingTools = false;
      this.changed();
    }
  }

  /** Downloads yt-dlp and FFmpeg into Guppy's folder (only what's missing or outdated). */
  installTools = () => this.runToolInstall(() => backend.installTools());

  updateYtdlp = () => this.runToolInstall(() => backend.updateYtdlp());

  private async runToolInstall(install: () => Promise<Tools>) {
    if (this.toolInstall) return;
    this.toolInstall = { tool: "yt-dlp", fraction: 0 };
    this.toolError = null;
    this.changed();
    try {
      this.tools = await install();
    } catch (error) {
      this.toolError = String(error);
    } finally {
      this.toolInstall = null;
      this.changed();
    }
  }

  /** Whether yt-dlp can be replaced now (not while it's running). */
  get canUpdateTools() {
    return this.toolInstall === null && !this.jobs.some((j) => j.status === "running") && !this.isFetching;
  }

  // MARK: - Link

  setLink(text: string) {
    this.link = text;
    this.fetchError = null;
    this.changed();
  }

  /** Puts a YouTube link from the clipboard into the empty field and looks it up. */
  private async offerClipboardLink() {
    if (this.link.trim() !== "" || this.info || !this.canDownload) return;
    const copied = (await backend.readClipboard()).trim();
    if (!isYouTubeLink(copied) || copied === this.clipboardLink) return;
    this.clipboardLink = copied;
    this.link = copied;
    await this.fetch();
  }

  async pasteAndFetch() {
    const copied = (await backend.readClipboard()).trim();
    if (!copied) return;
    this.clipboardLink = copied;
    this.setLink(copied);
    await this.fetch();
  }

  /** Looks up what's behind the link. */
  async fetch() {
    const link = linkIn(this.link);
    if (!link) {
      this.fetchError = this.link.trim() ? "That doesn't look like a link." : null;
      this.changed();
      return;
    }
    const id = ++this.fetchID;
    this.isFetching = true;
    this.fetchError = null;
    this.info = null;
    this.changed();
    try {
      const info = await backend.mediaInfo(link);
      if (id !== this.fetchID) return;
      this.info = info;
    } catch (error) {
      if (id !== this.fetchID) return;
      this.fetchError = String(error);
    } finally {
      if (id === this.fetchID) {
        this.isFetching = false;
        this.changed();
      }
    }
  }

  clearLink() {
    this.fetchID++;
    this.link = "";
    this.info = null;
    this.isFetching = false;
    this.fetchError = null;
    this.changed();
  }

  /** Video heights to offer for the current video (all of them for playlists). */
  get offeredHeights(): (number | null)[] {
    const highest = this.info?.heights[0];
    const heights = HEIGHTS.filter((h) => highest === undefined || h <= highest);
    return [null, ...heights];
  }

  get formatTitle() {
    const { mode, container, maxHeight, audioFormat, audioBitrate } = this.settings;
    if (mode === "video") {
      return `${CONTAINERS.find((c) => c.id === container)?.title} · ${maxHeight === null ? "Best" : heightTitle(maxHeight)}`;
    }
    const format = AUDIO_FORMATS.find((f) => f.id === audioFormat)!;
    return format.lossless ? `${format.id.toUpperCase()} · Lossless` : `${format.id.toUpperCase()} · ${audioBitrate} kbps`;
  }

  // MARK: - Queue

  /** Adds the video (or every video of the playlist) to the queue with the chosen format. */
  download() {
    if (!this.info || !this.canDownload) return;
    const { mode, maxHeight, container, audioFormat, audioBitrate, embedMetadata } = this.settings;
    for (const entry of this.info.entries) {
      this.addJob({
        title: entry.title,
        subtitle: entry.channel,
        thumbnail: entry.thumbnail,
        formatTitle: this.formatTitle,
        task: {
          kind: "download",
          options: { url: entry.url, audioOnly: mode === "audio", maxHeight, container, audioFormat, audioBitrate,
                     embedMetadata, folder: this.folder },
        },
      });
    }
    this.clearLink();
    this.pump();
  }

  /** Converts audio or video files on this PC to the chosen audio format. */
  convertFiles(paths: string[]) {
    const files = paths.filter((p) => MEDIA_FILE_EXTENSIONS.includes(pathExtension(p)));
    if (files.length === 0) {
      this.dialog = this.makeDialog("Guppy can't convert this file.",
        `Drop audio or video files (${MEDIA_FILE_EXTENSIONS.slice(0, 8).join(", ")}…).`, [{ title: "OK", role: "default" }]);
      this.changed();
      return;
    }
    const { audioFormat, audioBitrate } = this.settings;
    const format = AUDIO_FORMATS.find((f) => f.id === audioFormat)!;
    for (const path of files) {
      this.addJob({
        title: deletingPathExtension(lastPathComponent(path)),
        subtitle: `Converted from ${pathExtension(path).toUpperCase()}`,
        thumbnail: null,
        formatTitle: format.lossless ? `${format.id.toUpperCase()} · Lossless` : `${format.id.toUpperCase()} · ${audioBitrate} kbps`,
        task: { kind: "convert", options: { path, format: audioFormat, bitrate: audioBitrate, folder: this.folder } },
      });
    }
    this.pump();
  }

  async chooseFilesToConvert() {
    const paths = await backend.openFiles();
    if (paths.length > 0) this.convertFiles(paths);
  }

  private addJob(job: Omit<Job, "id" | "status" | "progress" | "file" | "error">) {
    this.jobs = [{ ...job, id: `job-${this.nextJobID++}`, status: "waiting", progress: null, file: null, error: null },
                 ...this.jobs];
    this.changed();
  }

  /** Starts waiting jobs, oldest first, while fewer than PARALLEL_JOBS run. */
  private pump() {
    const running = this.jobs.filter((j) => j.status === "running").length;
    const waiting = this.jobs.filter((j) => j.status === "waiting").reverse();
    for (const job of waiting.slice(0, Math.max(0, PARALLEL_JOBS - running))) {
      void this.run(job);
    }
  }

  private async run(job: Job) {
    job.status = "running";
    job.progress = null;
    job.error = null;
    this.changed();
    try {
      job.file = job.task.kind === "download"
        ? await backend.download(job.id, job.task.options)
        : await backend.convert(job.id, job.task.options);
      job.status = "done";
    } catch (error) {
      job.status = isCancellation(error) ? "cancelled" : "failed";
      job.error = isCancellation(error) ? null : String(error);
    }
    job.progress = null;
    this.changed();
    this.pump();
  }

  cancel(job: Job) {
    if (job.status === "running") {
      void backend.cancelJob(job.id);
    } else if (job.status === "waiting") {
      job.status = "cancelled";
      this.changed();
    }
  }

  retry(job: Job) {
    job.status = "waiting";
    job.error = null;
    job.file = null;
    this.changed();
    this.pump();
  }

  remove(job: Job) {
    this.jobs = this.jobs.filter((j) => j !== job);
    this.changed();
  }

  get hasFinishedJobs() {
    return this.jobs.some((j) => j.status === "done" || j.status === "cancelled" || j.status === "failed");
  }

  clearFinished() {
    this.jobs = this.jobs.filter((j) => j.status === "running" || j.status === "waiting");
    this.changed();
  }

  /** The line under a job's title. */
  statusText(job: Job): string {
    switch (job.status) {
      case "waiting":
        return "Waiting";
      case "cancelled":
        return "Cancelled";
      case "failed":
        return job.error ?? "Failed";
      case "done":
        return job.file ? lastPathComponent(job.file) : "Done";
      case "running": {
        const progress = job.progress;
        if (!progress) return job.task.kind === "download" ? "Starting…" : "Converting…";
        if (progress.stage === "processing") return "Finishing…";
        const parts = [progress.fraction !== null ? `${Math.round(progress.fraction * 100)} %` : null,
                       progress.speed ? formatSpeed(progress.speed) : null,
                       progress.eta !== null && progress.eta > 0 ? `${formatDuration(progress.eta)} left` : null];
        return parts.filter(Boolean).join(" · ") || (progress.stage === "converting" ? "Converting…" : "Downloading…");
      }
    }
  }

  reveal(job: Job) {
    if (job.file) void backend.revealInExplorer(job.file);
  }

  open(job: Job) {
    if (job.file) void backend.openPath(job.file);
  }

  openFolder() {
    void backend.openPath(this.folder);
  }

  async chooseFolder() {
    const folder = await backend.chooseFolder(this.folder);
    if (folder) this.set("folder", folder);
  }

  get folderName() {
    return lastPathComponent(this.folder) || this.folder;
  }

  get toolsFolder() {
    return this.tools?.folder ?? "";
  }

  // MARK: - Closing

  private makeDialog(message: string, information: string, buttons: DialogButton[],
                     onAnswer: (index: number) => void = () => {}): Dialog {
    const dialog: Dialog = {
      message, information, buttons,
      answer: (index) => {
        if (this.dialog === dialog) this.dialog = null;
        this.changed();
        onAnswer(index);
      },
    };
    return dialog;
  }

  /** Asks before quitting while something is downloading; stops it if the answer is yes. */
  shouldClose = async (): Promise<boolean> => {
    const active = this.jobs.filter((j) => j.status === "running" || j.status === "waiting");
    if (active.length === 0) return true;
    const quit = await new Promise<boolean>((resolve) => {
      this.dialog = this.makeDialog(
        active.length === 1 ? "A download isn't finished yet." : `${active.length} downloads aren't finished yet.`,
        "If you quit now, they stop and you'll have to start them again.",
        [{ title: "Keep Downloading", role: "default" }, { title: "Quit", role: "cancel" }],
        (index) => resolve(index === 1));
      this.changed();
    });
    if (quit) {
      await Promise.all(active.filter((j) => j.status === "running").map((j) => backend.cancelJob(j.id)));
      // Give yt-dlp a moment to be stopped (with FFmpeg) before the window goes.
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    return quit;
  };

}

export const model = new GuppyModel();

/** Re-renders the component whenever the model changes. */
export function useModel(): GuppyModel {
  useSyncExternalStore(model.subscribe, model.getVersion);
  return model;
}
