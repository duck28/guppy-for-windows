// The Rust backend (src-tauri), and dialog/opener/clipboard helpers. Opened in a plain browser (npm run dev
// without Tauri), it falls back to a simulation so the interface can be previewed and tested.

export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** An installed yt-dlp or FFmpeg. */
export interface Tool {
  path: string;
  /** yt-dlp: a release date such as "2026.10.21". FFmpeg: its build name. */
  version: string;
  /** Downloaded by Guppy into its own folder. */
  isManaged: boolean;
}

export interface Tools {
  ytdlp: Tool | null;
  ffmpeg: Tool | null;
  /** YouTube regularly breaks older yt-dlp releases. */
  ytdlpOutdated: boolean;
  /** Where Guppy keeps the tools it downloads. */
  folder: string;
}

/** A video, or one video of a playlist. */
export interface Entry {
  url: string;
  title: string;
  channel: string | null;
  duration: number | null;
  thumbnail: string | null;
}

export interface MediaInfo {
  isPlaylist: boolean;
  title: string;
  channel: string | null;
  thumbnail: string | null;
  /** Video heights on offer (2160, 1080…), highest first. Empty for playlists. */
  heights: number[];
  /** The video itself, or the videos of the playlist. */
  entries: Entry[];
}

export interface Progress {
  /** 0...1, or null while it isn't known. */
  fraction: number | null;
  /** Bytes per second. */
  speed: number | null;
  /** Seconds left. */
  eta: number | null;
  stage: "downloading" | "processing" | "converting";
}

export type Container = "mp4" | "mkv" | "webm";
export type AudioFormat = "mp3" | "m4a" | "opus" | "flac" | "wav";

export interface DownloadOptions {
  url: string;
  audioOnly: boolean;
  /** The highest video height; null for the best there is. */
  maxHeight: number | null;
  container: Container;
  audioFormat: AudioFormat;
  /** kbps, for the lossy audio formats. */
  audioBitrate: number;
  embedMetadata: boolean;
  folder: string;
}

export interface ConvertOptions {
  path: string;
  format: AudioFormat;
  bitrate: number;
  folder: string;
}

type Unlisten = () => void;

export interface Backend {
  findTools(): Promise<Tools>;
  /** Downloads whatever is missing. Emits `tools-progress` ({ tool, fraction }). */
  installTools(): Promise<Tools>;
  /** Emits `tools-progress`. */
  updateYtdlp(): Promise<Tools>;
  mediaInfo(url: string): Promise<MediaInfo>;
  /** Emits `job-progress` ({ id, ...Progress }). Resolves with the saved file; rejects with "cancelled" if cancelled. */
  download(id: string, options: DownloadOptions): Promise<string>;
  /** Emits `job-progress`. Resolves with the new file. */
  convert(id: string, options: ConvertOptions): Promise<string>;
  cancelJob(id: string): Promise<void>;
  defaultFolder(): Promise<string>;
  listen<T>(event: string, handler: (payload: T) => void): Promise<Unlisten>;

  chooseFolder(defaultPath: string): Promise<string | null>;
  openFiles(): Promise<string[]>;
  revealInExplorer(path: string): Promise<void>;
  openPath(path: string): Promise<void>;
  readClipboard(): Promise<string>;
}

export const MEDIA_FILE_EXTENSIONS = ["mp3", "m4a", "aac", "wav", "flac", "ogg", "oga", "opus", "wma", "aif", "aiff",
                                      "mp4", "m4v", "mov", "mkv", "webm", "avi", "wmv"];

// MARK: - Tauri

async function makeTauriBackend(): Promise<Backend> {
  const { invoke } = await import("@tauri-apps/api/core");
  const { listen } = await import("@tauri-apps/api/event");
  const dialog = await import("@tauri-apps/plugin-dialog");
  const opener = await import("@tauri-apps/plugin-opener");
  const clipboard = await import("@tauri-apps/plugin-clipboard-manager");

  return {
    findTools: () => invoke("find_tools"),
    installTools: () => invoke("install_tools"),
    updateYtdlp: () => invoke("update_ytdlp"),
    mediaInfo: (url) => invoke("media_info", { url }),
    download: (id, options) => invoke("download", { id, options }),
    convert: (id, options) => invoke("convert", { id, options }),
    cancelJob: (id) => invoke("cancel_job", { id }),
    defaultFolder: () => invoke("default_folder"),
    listen: (event, handler) => listen(event, (e) => handler(e.payload as never)),

    chooseFolder: async (defaultPath) => {
      const result = await dialog.open({ directory: true, defaultPath });
      return typeof result === "string" ? result : null;
    },
    openFiles: async () => {
      const result = await dialog.open({ multiple: true, directory: false,
                                         filters: [{ name: "Audio and video", extensions: MEDIA_FILE_EXTENSIONS }] });
      return Array.isArray(result) ? result : typeof result === "string" ? [result] : [];
    },
    revealInExplorer: (path) => opener.revealItemInDir(path),
    openPath: (path) => opener.openPath(path),
    readClipboard: async () => (await clipboard.readText().catch(() => "")) ?? "",
  };
}

// MARK: - Browser preview

/** A placeholder thumbnail in Guppy's colors. */
function sampleThumbnail(hue: number) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 90"><defs><linearGradient id="g" x2="1" y2="1">`
    + `<stop offset="0" stop-color="hsl(${hue} 95% 62%)"/><stop offset="1" stop-color="hsl(${hue + 18} 90% 48%)"/>`
    + `</linearGradient></defs><rect width="160" height="90" fill="url(#g)"/>`
    + `<path d="M70 32 L94 45 L70 58 Z" fill="white" fill-opacity="0.85"/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function makePreviewBackend(): Backend {
  const local = new EventTarget();
  const emit = (event: string, payload: unknown) => local.dispatchEvent(new CustomEvent(event, { detail: payload }));
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const cancelled = new Set<string>();
  // #setup previews the first launch, before yt-dlp and FFmpeg are there.
  let installed = location.hash !== "#setup";
  const tools = (): Tools => installed
    ? {
        ytdlp: { path: "C:\\Users\\You\\AppData\\Local\\Guppy\\bin\\yt-dlp.exe", version: "2026.10.21", isManaged: true },
        ffmpeg: { path: "C:\\Users\\You\\AppData\\Local\\Guppy\\bin\\ffmpeg.exe", version: "N-127043-g5a54fcf75e", isManaged: true },
        ytdlpOutdated: false,
        folder: "C:\\Users\\You\\AppData\\Local\\Guppy\\bin",
      }
    : { ytdlp: null, ffmpeg: null, ytdlpOutdated: false, folder: "C:\\Users\\You\\AppData\\Local\\Guppy\\bin" };

  const run = async (id: string, stages: { stage: Progress["stage"]; steps: number }[]) => {
    for (const { stage, steps } of stages) {
      for (let step = 0; step <= steps; step++) {
        if (cancelled.has(id)) throw "cancelled";
        const fraction = stage === "processing" ? null : step / steps;
        emit("job-progress", { id, fraction, speed: stage === "downloading" ? 4_200_000 + Math.random() * 900_000 : null,
                               eta: stage === "downloading" ? (steps - step) * 0.15 : null, stage });
        await sleep(150);
      }
    }
  };

  return {
    findTools: async () => {
      await sleep(300);
      return tools();
    },
    installTools: async () => {
      for (const tool of ["yt-dlp", "FFmpeg"]) {
        for (let fraction = 0; fraction <= 1; fraction += 0.04) {
          emit("tools-progress", { tool, fraction });
          await sleep(60);
        }
      }
      installed = true;
      return tools();
    },
    updateYtdlp: async () => {
      for (let fraction = 0; fraction <= 1; fraction += 0.1) {
        emit("tools-progress", { tool: "yt-dlp", fraction });
        await sleep(60);
      }
      return tools();
    },
    mediaInfo: async (url) => {
      await sleep(700);
      if (url.includes("fail")) throw "Video unavailable. This video is private. If this keeps happening, update yt-dlp in Settings.";
      if (url.includes("list=")) {
        const titles = ["Morning Session – Part 1", "Morning Session – Part 2", "Afternoon Q&A", "Closing Notes"];
        const entries = titles.map((title, i) => ({
          url: `https://www.youtube.com/watch?v=sample${i}`, title, channel: "Guppy Sessions", duration: 600 + i * 137,
          thumbnail: sampleThumbnail(24 + i * 6),
        }));
        return { isPlaylist: true, title: "Guppy Sessions 2026", channel: "Guppy Sessions", thumbnail: entries[0].thumbnail,
                 heights: [], entries };
      }
      const entry = { url, title: "How Guppies Got Their Colorful Tails", channel: "Freshwater Notes", duration: 754,
                      thumbnail: sampleThumbnail(28) };
      return { isPlaylist: false, title: entry.title, channel: entry.channel, thumbnail: entry.thumbnail,
               heights: [2160, 1440, 1080, 720, 480, 360], entries: [entry] };
    },
    download: async (id, options) => {
      await run(id, [{ stage: "downloading", steps: 24 }, { stage: "processing", steps: 4 }]);
      const extension = options.audioOnly ? options.audioFormat : options.container;
      return `${options.folder}\\Sample.${extension}`;
    },
    convert: async (id, options) => {
      await run(id, [{ stage: "converting", steps: 16 }]);
      return `${options.folder}\\Sample.${options.format}`;
    },
    cancelJob: async (id) => void cancelled.add(id),
    defaultFolder: async () => "C:\\Users\\You\\Downloads",
    listen: async (event, handler) => {
      const listener = (e: Event) => handler((e as CustomEvent).detail);
      local.addEventListener(event, listener);
      return () => local.removeEventListener(event, listener);
    },
    chooseFolder: async (defaultPath) => defaultPath,
    openFiles: async () => ["C:\\Users\\You\\Music\\Voice Memo.m4a"],
    revealInExplorer: async () => {},
    openPath: async () => {},
    readClipboard: async () => (await navigator.clipboard?.readText().catch(() => "")) ?? "",
  };
}

export const backend: Backend = isTauri ? await makeTauriBackend() : makePreviewBackend();
