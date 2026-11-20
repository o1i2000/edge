# Edge

A finger-strength testing app for the Tindeq Progressor. It talks to the Progressor directly over
Bluetooth using Tindeq's public interface, finds each pull as you do it, and keeps a history of your
peak force for each hand with a trend.

Right now it does one workout, **peak force**. Sessions are stored with a `type` so more workouts can
be added later without migrating data.

It is plain HTML, CSS and JavaScript modules. There is no build step and no dependencies.

## Run it

Web Bluetooth only works over https (or localhost), and not in iPhone Safari or Chrome.

- **iPhone:** open the hosted page in the free [Bluefy](https://apps.apple.com/app/bluefy-web-ble-browser/id1492822055) browser.
- **Android or desktop Chrome:** open the hosted page normally.
- **Try without a Progressor:** tap "Try the demo" on the first screen. Add `?speed=8` to the URL to run it eight times faster.
- **Locally:** `python3 -m http.server 8765` in this folder, then open http://localhost:8765/.

Close the Tindeq app first. A Progressor only talks to one app at a time.

## Files

| File | What it does |
| --- | --- |
| `js/core.js` | Packet decoding, pull detection, metrics, statistics, CSV export. No DOM, no Bluetooth. |
| `js/device.js` | `ProgressorBLE` (Web Bluetooth) and `ProgressorSim` (scripted demo) with the same interface. |
| `js/store.js` | IndexedDB sessions and local settings. |
| `js/charts.js` | Live canvas trace, trend, bar and force-curve charts. |
| `js/app.js` | State, views and the session flow. |
| `js/demo.js` | The scripted pulls and sample history used by the demo and tests. |

## Tests

- `node --test tests/core.test.mjs` covers decoding, pull detection, metrics and statistics.
- `python3 tests/e2e.py` drives the whole app in demo mode with Playwright. Start the local server first.

## Progressor protocol

Service `7e4e1701-1ea6-40c9-9dcc-13d34ffead57`, data (notify) `7e4e1702-…`, control (write) `7e4e1703-…`.
Commands are single bytes: tare 100, start 101, stop 102, firmware 107, sleep 110, battery 111.
Weight packets are `[1, length, (float32 kg, uint32 microseconds) × N]`, little endian.
The full interface is published by Tindeq: https://github.com/blims/Tindeq-Progressor-API

Edge is not made by or affiliated with Tindeq.
