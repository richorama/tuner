# Neon Tuner

A bling, neon-cyberpunk **chromatic tuner** for guitar and bass that runs entirely in the browser. It listens through your microphone, detects the note you're playing, and shows in real time how close you are with a needle gauge, LED strip, strobe ribbon, amplitude meter and a scrolling pitch-history graph. Installable as a PWA and works offline.

> No build step, no dependencies, no tracking — just open it and play.

## Features

- 🎸 **Chromatic detection** — recognises all 12 notes across the full guitar/bass range
- 🎯 **Needle gauge** with cents readout and a green in-tune zone (±4 cents)
- 💡 **LED cents strip** and an authentic **strobe ribbon** that slows to a stop when in tune
- 📈 **Pitch history** graph and a live **input / amplitude (dB)** meter
- 🎚️ **Guitar & Bass** modes with standard-tuning string guides that light up on target
- 🔧 Adjustable **A4 reference** (415–466 Hz)
- 📱 **PWA** — installable to your home screen and fully offline-capable
- 🎨 Refined neon UI, responsive, with reduced-motion and keyboard-focus support

## Quick start

The app is fully static. Microphone access requires a **secure context**, so serve it over `http://localhost` or HTTPS (opening the file directly with `file://` will not grant mic access).

```bash
# from the project folder
python3 -m http.server 8765
# then open http://localhost:8765
```

Any static server works just as well, for example:

```bash
npx serve .
# or
php -S localhost:8765
```

Open the page, tap **START**, and allow microphone access when prompted.

> 💡 Use headphones to avoid the speaker feeding back into the mic.

## How it works

1. The mic stream is captured via the **Web Audio API** (`getUserMedia` + `AnalyserNode`), with echo cancellation, noise suppression and auto-gain **disabled** for an accurate signal.
2. Each frame, the time-domain buffer is run through an **autocorrelation** pitch detector with **parabolic interpolation** for sub-sample accuracy.
3. The detected frequency is converted to the nearest note and a cents deviation, using the configurable A4 reference:

   $$\text{midi} = 12\,\log_2\!\left(\frac{f}{A_4}\right) + 69, \qquad \text{cents} = (\text{midi} - \text{round(midi)}) \times 100$$

4. All visuals (gauge, strobe, LEDs, history, amplitude) are rendered to `<canvas>` / DOM and eased for smooth, jitter-free motion.

## Project structure

| File | Purpose |
| --- | --- |
| `index.html` | App shell and markup |
| `styles.css` | Neon theme, layout and animations |
| `app.js` | Audio capture, pitch detection and all rendering |
| `manifest.webmanifest` | PWA metadata |
| `sw.js` | Service worker (offline app-shell cache) |
| `icon.svg` | App / install icon |

## Browser support

Works in modern browsers that support the Web Audio API and `getUserMedia` (Chrome, Edge, Firefox, Safari). On iOS, audio starts only after the **START** tap (a required user gesture).

## Privacy

Audio is processed **locally in your browser** in real time. Nothing is recorded, stored or sent anywhere.

## License

[MIT](LICENSE) © 2026 Rich
