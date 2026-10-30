# Dashcam Player

Plays Wolfbox G840S recordings in a web page: front and rear cameras together, one timeline for the whole trip, the route and speed on a
map, all in sync. Everything runs in your browser; nothing is uploaded and your recordings are only ever read.

> **Tested only with Wolfbox G840S video files.** Every format detail here (the MPEG-TS layout, the file names `FILEyymmdd-hhmmss[F|R]`,
> the embedded GPS and the transform that decodes its coordinates) was worked out from, and checked against, recordings from that one camera
> (one SD card, one trip). Other Wolfbox models or other brands' dashcams may not play, may have no or wrongly placed GPS, or may show wrong speeds.

Not affiliated with, endorsed by or supported by Wolfbox; the name is used only to say which camera this was made for.

## Use it (nothing to install)

Open **`release/DashcamPlayer.html`** in Chrome, Edge or Safari. It is one self-contained file (about 740 KB): no Node, no server, no
ffmpeg. Send that single file to anyone. Only the map background needs the internet.

1. Drag in the recordings (folders or files, as many times as you like, from different places) or use *Choose folder / files*.
2. Press **Start**. (*Preview route (GPS only)* first, if you want to see the route before opening any video.)

Inputs: `.TS` clips from `Normal/F` and `Normal/R` on the card, or `.mp4` copies of them, plus optional `.gpx` files. Front and rear are
paired by file name. Other files on the card are ignored.

## While playing

- **Views**: picture-in-picture (click the small camera to swap it with the big one), front, rear, map only. *Map only* opens no video at all.
- **Click the picture** to play/pause. A corner panel shows speed, time and date over the camera's own burned-in text
  (Settings → *Info panel on the picture* turns it off to show the original picture).
- **Timeline**: click or drag anywhere; hover shows the time of day. Under it, a thin strip shows what is ready (white) and the next part being
  prepared (amber). Amber hatching on the timeline = a camera is missing, red mark = footage missing before that clip.
- **Options** under the timeline: speed 0.5×–4×, mute, volume, sound from front or rear, full screen. Speed, sound, view, GPS on/off and the
  speed unit are remembered in this browser (Settings → *Reset remembered options*).
- **Keys**: `Space` play/pause · `← →` 5 s (`Shift` 30 s) · `[ ]` previous/next clip · `Home End` · `, .` slower/faster · `↑ ↓` volume · `M` mute · `F` full screen.
- **Add files** at any time from the header; they join the running trip and the position is kept. *Files → Clear all* starts over.
- **Diagnostics** tab: browser, engine, counters, clips in memory, hand-overs, GPS and warnings; *Copy report* for bug reports.

## GPS

Each recording carries its own GPS (`$GPRMC` sentences, about one per second, speed in knots). The player reads it as each part is prepared,
so no `.gpx` is needed; a `.gpx` (per clip, or one for the whole trip) replaces it. The route only ever grows. The camera's coordinates are
stored obfuscated; the player decodes them with a transform fitted on one device (worst error 0.08 m against the official GPX), so treat
positions as inferred. Settings has a GPS offset and the speed unit.

## How playback works

Browsers cannot play raw `.TS`, so each recording is converted to a small MP4 **in memory, in 15-second windows**, in a Web Worker:

- Only the bytes of a window are read (the converter jumps to the keyframe before it by interpolating the byte position) and only the
  current and next window are held, so memory stays around 100–130 MB for front + rear whatever the length of the recording.
- `.mp4` files are played straight from the file; if the browser cannot read them that way, from a copy in memory.
- **Hand-over between windows is make-before-break**: each window also holds 2.5 s of the previous one and plays 1.5 s past its end. About a
  second before the end, the next window is lined up on the frame the old one will show, started at that instant, trimmed by running
  slightly faster/slower, and the picture is switched only when both are within ~35 ms. Between two clips (no earlier footage to overlap)
  the switch happens after the next picture's first frame. Above 2× speed the plain switch is used.
- **It cannot get stuck**: every wait has a time limit; a failed overlap falls back to the plain switch (and turns the overlap off after two
  failures; Settings → *Hand-over*); playback that stops by itself, or a hand-over not finished in 4 s, restarts from the current position.
- Reads are retried before the player reports that a file could not be read (card removed or file moved).
- If a browser plays the sound but shows no picture, the player switches itself to MediaSource streaming (Settings → *Raw .TS playback*).

The converted MP4 is a plain one (ftyp, moov with sample tables, mdat), not a fragmented one: mux.js only writes fragmented files, which
Chrome plays and Safari shows as black video, so `src/media/mp4File.ts` rewrites them.

## Not verified

- **Any camera other than the Wolfbox G840S.** No other model or brand was tried. The GPS decoding in particular is a fit to this one camera.
- **Safari** (macOS, iOS) has not been tested by the developer: the seamless hand-over, the converted MP4 and the worker are all measured
  in Chrome only. If something misbehaves, open Diagnostics → *Copy report*.
- A recording that reads badly from the card (junk bytes, lost packets) plays badly. This was seen once and was caused by how the card was
  mounted, not by the files: remount the card or copy the files off it. The converter still drops frames with garbage timestamps.
- Not measured: iPhone/iPad memory limits, a real 5-minute recording, a full 46-clip trip start to finish.
- The last clip of the sample card (`…081214`) is unreadable (no PAT/PMT) and is skipped with a warning.

## Build `DashcamPlayer.html`

```bash
npm ci             # install exactly what the build needs (React, Leaflet, mux.js, Vite)
npm run bundle     # builds and writes release/DashcamPlayer.html
```

That is the whole project: `src/` (the app), `index.html`, `vite.config.ts`, `tsconfig.json`, `scripts/bundle.mjs` (inlines the script, styles and
converter worker into the one file) and the lock file.

```
src/recordings  file-name parsing, front/rear pairing, trip timeline
src/gps         GPX parser, embedded-GPS decoder, append-only track store, speed units
src/media       TS reader/probe, window converter (worker), plain-MP4 writer, clips, PlaybackController (slots, hand-over, clock)
src/components  video panels, transport, timeline, map, telemetry, clips list, diagnostics
src/app         App, loading flow, file helpers, remembered options
```

## License

MIT, see `LICENSE`. The player file bundles React, Leaflet, mux.js and a few small helpers; their licenses are in `THIRD_PARTY_LICENSES.txt`.
The map background loads from OpenStreetMap's public tile server (© OpenStreetMap contributors, ODbL). That server is meant for light use: if you
host this page for many people, point the map at your own tile provider (see the OpenStreetMap tile usage policy).
