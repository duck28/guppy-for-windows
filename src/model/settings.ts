// Preferences, kept in localStorage.

import type { AudioFormat, Container } from "./backend";

export type Mode = "video" | "audio";

export const CONTAINERS: { id: Container; title: string }[] = [
  { id: "mp4", title: "MP4" },
  { id: "mkv", title: "MKV" },
  { id: "webm", title: "WebM" },
];

export const AUDIO_FORMATS: { id: AudioFormat; title: string; lossless: boolean }[] = [
  { id: "mp3", title: "MP3", lossless: false },
  { id: "m4a", title: "M4A (AAC)", lossless: false },
  { id: "opus", title: "Opus", lossless: false },
  { id: "flac", title: "FLAC", lossless: true },
  { id: "wav", title: "WAV", lossless: true },
];

export const BITRATES = [320, 256, 192, 128];

/** Video heights offered; null is the best there is. */
export const HEIGHTS = [2160, 1440, 1080, 720, 480, 360];

export function heightTitle(height: number | null) {
  if (height === null) return "Best quality";
  if (height >= 2160) return "4K (2160p)";
  if (height >= 1440) return "2K (1440p)";
  return `${height}p`;
}

export interface Settings {
  /** Empty means the Downloads folder. */
  folder: string;
  mode: Mode;
  maxHeight: number | null;
  container: Container;
  audioFormat: AudioFormat;
  audioBitrate: number;
  embedMetadata: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  folder: "",
  mode: "video",
  maxHeight: null,
  container: "mp4",
  audioFormat: "mp3",
  audioBitrate: 320,
  embedMetadata: true,
};

export function loadSettings(): Settings {
  const settings = { ...DEFAULT_SETTINGS };
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
    try {
      const stored = localStorage.getItem(key);
      if (stored !== null) (settings as Record<string, unknown>)[key] = JSON.parse(stored);
    } catch {
      // Unreadable or missing storage: keep the default.
    }
  }
  return settings;
}

export function storeSetting<K extends keyof Settings>(key: K, value: Settings[K]) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage unavailable: the change still applies until the app quits.
  }
}
