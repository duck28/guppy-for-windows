<p align="center"><img src="public/logo.svg" width="112" alt="Guppy"></p>

# Guppy for Windows

A clean, minimal YouTube downloader for Windows. Paste a link, pick **Video** or **Audio**, and download. Guppy can also convert audio and video files on your PC into common audio formats.

There's also [Guppy for Mac](https://github.com/duck28/guppy-for-mac), which does the same things.

## Features

- **Video:** MP4, MKV or WebM, from 360p up to 4K. MP4 prefers H.264/AAC so it plays everywhere.
- **Audio:** MP3, M4A (AAC), Opus (128–320 kbps), or lossless FLAC and WAV.
- **Playlists:** a playlist link puts every video in the queue.
- **Convert files:** drop audio or video files on the window to convert them to the selected audio format.
- **Cover art and tags:** title, artist, chapters and the thumbnail are embedded (can be turned off in Settings).
- **Queue:** two downloads run at a time, with progress, speed and time left. You can cancel, retry, play or show any download in Explorer.
- **Clipboard:** a YouTube link on the clipboard is picked up when you switch to Guppy.

Guppy downloads with [yt-dlp](https://github.com/yt-dlp/yt-dlp) and converts with [FFmpeg](https://ffmpeg.org). It uses copies already on the PC (winget, Scoop, Chocolatey, pip, PATH). If none are found, **Set Up** downloads them once into `%LOCALAPPDATA%\Guppy\bin`. **Settings › Update** gets the newest yt-dlp, which usually fixes downloads after YouTube changes something.

Only download content you have the right to.

## Download and install

Requires Windows 10 or 11 (64-bit) with the WebView2 runtime, which Windows 11 already has (the installer adds it on Windows 10 if needed).

Download one of these from the [latest release](https://github.com/duck28/guppy-for-windows/releases/latest):

- `Guppy_<version>_x64-setup.exe`: installer for your user account, no administrator rights needed (recommended).
- `Guppy_<version>_x64_en-US.msi`: Windows Installer package, for installing with administrator rights or deploying to several PCs.

### The installers are not code-signed

The installers aren't signed with a code-signing certificate, so Windows doesn't know who published them:

- Your browser may say the file *isn't commonly downloaded*. In Edge, choose **⋯ › Keep**, then **Show more › Keep anyway**.
- When you run it, Microsoft Defender SmartScreen shows **Windows protected your PC**. Click **More info**, then **Run anyway**.

### Verify a download

Every release file is attested by the GitHub Actions run that built it ([build provenance](https://docs.github.com/actions/security-for-github-actions/using-artifact-attestations)). With the [GitHub CLI](https://cli.github.com):

```powershell
gh attestation verify Guppy_1.0.0_x64-setup.exe --repo duck28/guppy-for-windows
```

## Build from source

Built with [Tauri 2](https://tauri.app): a Rust backend (`src-tauri/`) and a React 19 + TypeScript + Vite interface (`src/`), the Inter font and Lucide icons.

Requires Node.js 22+, Rust (`winget install Rustlang.Rustup`) and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) (Microsoft C++ Build Tools, WebView2).

```powershell
npm install
npx tauri build
```

The installers are written to `src-tauri/target/release/bundle/` (`nsis/*-setup.exe` and `msi/*.msi`).

- `npx tauri dev` runs the app with live reload.
- `npm run dev` opens the interface in a browser with a simulated backend; `http://localhost:1420/#setup` simulates the first launch.
- `cargo test` (in `src-tauri/`) runs the unit tests. `cargo test -- --ignored` also downloads a short video with the real yt-dlp and FFmpeg.
- The [build workflow](.github/workflows/build.yml) builds and tests every push to `main` and every pull request.

After changing `public/logo.svg`, render it to a 1024 px PNG and run `npx tauri icon <png> -o src-tauri/icons`.

## Releasing

1. Set the same new version (for example `1.0.1`) in `package.json`, `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml`, and build once so `Cargo.lock` and `package-lock.json` follow.
2. Commit, then push a tag that matches the version with a `v` in front:
   ```powershell
   git tag v1.0.1; git push origin v1.0.1
   ```
3. The [release workflow](.github/workflows/release.yml) checks that the tag matches all three versions, runs the tests, builds both installers on a Windows runner, attests them, and creates a **draft** release. Review it on GitHub and publish it.

## Code

| Part | File |
| --- | --- |
| Finding, installing and running yt-dlp/FFmpeg | `src-tauri/src/tools.rs` |
| Video info and downloads (yt-dlp) | `src-tauri/src/ytdlp.rs` |
| File conversion (FFmpeg) | `src-tauri/src/convert.rs` |
| Tauri commands | `src-tauri/src/lib.rs` |
| App state and queue | `src/model/GuppyModel.ts` |
| Interface | `src/ui/` and `src/styles.css` (white and orange) |
| Logo | `public/logo.svg` (app icons in `src-tauri/icons/` are generated from it) |

## License

[MIT](LICENSE)
