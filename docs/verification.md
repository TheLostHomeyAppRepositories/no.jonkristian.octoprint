# OctoPrint fixes: verification

Local regression checks use mocked Homey/network interfaces. One test also imports the
installed node-fetch and consumes a local `data:` URL; it makes no network request.
These checks do not prove physical printer control or Homey camera playback.

```powershell
npm run lint
npm test
npm audit --omit=dev
homey app validate --level debug
git diff --check
```

Homey validation regenerates output. For this review it is run in a disposable copy
of the current source, preserving the working checkout's generated files.
There is no separate compilation step in this CommonJS JavaScript application.
Publication validation and installation are not part of this local change.

## Local verification record

- `node --check` on app.js, lib/octoprint.js, lib/fetch.js, both driver JavaScript
  files, widget api.js, eslint.config.js, and tests/regressions.test.js: passed.
- `npm run lint`: passed with the installed ESLint 10 flat configuration.
- `npm test`: 28 regression tests passed.
- `npm audit --omit=dev`: no production vulnerabilities reported.
- `homey app validate --level debug`: passed in the disposable source copy.
  Generated JavaScript was compared with source and generated app.json with Compose.
- `git diff --check`: passed; accumulated diff and working tree inspected.
- Analysis used `rg`, PowerShell `Get-Content`, read-only Git diff/status/show,
  installed package inspection, and official Homey/camera-streamer/Go2RTC sources.
- Sol Advisor route: audit; implementation by the primary session. Reviewer role
  preflight passed and runtime metadata confirmed gpt-5.6-sol/high. The fresh reviewer
  stopped at its usage limit, so there is no review verdict. Its attempted review
  changed no captured files (before/after SHA-256 comparison). The final H.264 Auto
  revision is locally checked but still requires the independent review.
- No printer/Homey communication, app installation, publication, commit, or push was
  performed. Playback and physical printer behavior remain runtime-unverified.

## Manual Homey smoke tests

After installing the reviewed changes yourself:

1. Restart the app and confirm printer state, temperatures, and job information update
   without `fetch is not a function`, unhandled rejections, or duplicate polling.
2. With a safe idle printer, change a target temperature and return it to zero. Verify
   the device and its Flow reflect the change, including the chamber action when a
   heated chamber exists. Verify a rejected command fails its Flow instead of reporting
   success. Test cancellation/emergency stop only in a scenario you deliberately choose.
3. Try pairing with an invalid API key: pairing must fail. Change an existing device's
   address/API key to another valid test connection: polling and camera requests must
   use the new connection without an app restart. Restore your normal settings.
4. Enable snapshots, request a fresh image, change its URL, then disable snapshots.
   Requests from the old image must stop working. Re-enable and confirm images work.
   A failing custom URL should report failure rather than show another camera.
5. Open video on mobile and web, change the stream format, and disable/re-enable it.
   Verify the previous video stops being usable and only one current stream is registered.
   Restart the app and repeat. Note the Homey firmware and selected format with results.
6. During a planned OctoPrint/camera outage, check that polling retries and recovers
   when the service returns. A snapshot/video failure must not stop printer telemetry.
7. Run two heating/cooling cycles. Both cooldown Flows must fire. If you have two
   printers, repeat with equal temperatures on both. Check estimated-end-time Flow tokens.
8. Check the dashboard widget's device selection, data updates, and zero temperatures.
   Delete a disposable test device and confirm there are no later poll/reset callbacks.

## Mobile works but web is unavailable

Homey's mobile app embeds VLC and can handle formats that browser playback cannot.
Homey documents its automatic WebRTC proxy from firmware 12.12.0; keep **Disable
WebRTC proxy** off when testing web playback through that proxy.

The supplied web log reports `magic: unsupported header: 1a45dfa3`: Homey's proxy
rejects the EBML/Matroska container returned by `/webcam/video`. Auto now supplies
**raw H.264** (`/webcam/video.h264`) to Homey's WebRTC proxy, avoiding that demuxer
path and camera-streamer's native SDP negotiation. The endpoint is defined in
camera-streamer's HTTP routes and Go2RTC explicitly supports raw H.264 input.
It requires camera-streamer with H.264 enabled and Homey's WebRTC proxy. With
**Disable WebRTC proxy** on, Auto retains direct `/webcam/video` for mobile players.
Explicit WebRTC, MKV, MP4, HLS, MJPEG, and custom selections remain unchanged.

For the reported case, keep **Auto** selected and **Disable WebRTC proxy** off.
After restarting the updated app, the configuration log must show
`effectiveStreamMode: 'h264_proxy'`, `videoFactory: 'createVideoOther'`, and
`webrtcDataChannel: false`. Open the camera on web and mobile, verify uninterrupted
playback, close/reopen it, and check that the unsupported-header error no longer
appears. If it still fails, capture the Homey app's stdout/stderr (the terminal
running the app or app diagnostics), including configuration and URL-request lines;
browser console output alone does not show the app-side configuration. The reported
`moz-extension://.../collectFormData.js` exception belongs to a browser extension.

If mobile briefly shows an error before playing, compare with snapshots disabled to
isolate a failing loading image. Record logs around opening the camera, not just app
startup. A startup `Configuring stream video` message proves registration only.

Sources:
- https://apps.developer.homey.app/advanced/videos
- https://github.com/ayufan/camera-streamer/blob/main/docs/streaming.md
- https://github.com/ayufan/camera-streamer/blob/main/output/webrtc/webrtc.cc
- https://github.com/ayufan/camera-streamer/blob/main/cmd/camera-streamer/http.c
- https://github.com/ayufan/camera-streamer/blob/main/output/http_h264.c
- https://github.com/AlexxIT/go2rtc/blob/master/pkg/magic/producer.go
- https://github.com/AlexxIT/go2rtc/blob/master/pkg/magic/bitstream/producer.go

## Dependencies and compatibility

Changed implementation files are `lib/octoprint.js`, new `lib/fetch.js`,
`drivers/octoprint/device.js`, `drivers/octoprint/driver.js`, pairing `start.html`,
`app.js`, and `widgets/octoprint/api.js`. Camera setting labels/hints are updated in
`drivers/octoprint/driver.settings.compose.json` and generated `app.json`.
`package.json`, `eslint.config.js` (replacing `.eslintrc.json`), and
`tests/regressions.test.js` provide the local check setup. This document records
verification and manual tests; the existing dependency/lock updates are preserved.

Homey interfaces used are existing Device capability/Flow listeners, lifecycle
hooks, Image setStream/update/unregister, camera attachment, and ManagerVideos
factories/listeners/unregister. No new production dependency was added by this fix.

The concurrent updates to node-fetch 3.3.2, Luxon 3.7.2, Homey types 0.3.12, and ESLint
10.10.0 are preserved. node-fetch is loaded with dynamic import from CommonJS, as
required by its ESM-only package. Production code retains Node 16+ compatibility;
ESLint 10 is a development tool requiring Node 20.19+, 22.13+, or 24+.
No app version, paired-device identifiers, capability IDs, Flow card IDs/arguments,
settings keys, or stored data formats are changed. No data migration is required.

One-line changelog: Fixed API compatibility, web camera streaming, snapshot cleanup, polling recovery, printer commands, pairing, Flow triggers, time calculations, and widgets.
