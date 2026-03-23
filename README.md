# SSAP Install Bridge

Static browser companion for LG webOS TVs.

Live page:

- https://azoffshowy.github.io/ssap-install-bridge/

The app connects to a TV over SSAP, runs a small visible check, and then drives a three-step IPK flow:

1. request a download
2. wait a few seconds
3. request install
4. wait again
5. request launch

The project is intended for GitHub Pages under the project site URL:

- `https://azoffshowy.github.io/ssap-install-bridge/`

## Layout

- `docs/` contains the GitHub Pages app
- `docs/resources/` contains the IPKs exposed by GitHub Pages

## Local Run

Serve the repository root so both `docs/` and `docs/resources/` are reachable:

```sh
cd ssap-install-bridge
python3 -m http.server 8080
```

Then open:

```text
http://localhost:8080/docs/
```

## Intended Flow

### 1. Connect

- Enter the TV IP and connect over SSAP (allow connect on the TV).
- If the page is served over HTTPS, the app automatically prefers `wss://<tv-ip>:3001`.
- Accept the TV certificate once in the browser if needed.

### 2. Run Quick Check

- The quick check creates a visible toast on the TV.
- This is the fastest way to confirm that the bridge is responsive before attempting delivery.

### 3. Run The Workflow

The workflow pane supports two presets:

- `Developer Mode Bootstrap`
- `Homebrew Channel Post-DevMode`

Each preset fills:

- package URL
- target filename
- app ID
- install endpoint

By default the published app uses the final GitHub Pages package URLs, so the browser already sends TV-friendly absolute URLs.

### 4. Advanced Settings

Advanced settings stay collapsed by default and let you adjust:

- download directory
- filename
- trigger phase
- wait time between steps
- install endpoint
- prompt text shown during each stage

## Notes

- The browser can confirm the SSAP-side calls, but not every downstream action on the TV is directly observable.
- For release use, the safest approach is to validate the flow with known-good IPKs and then keep the same structure.
- Opening `docs/index.html` directly via `file://` will not work because browsers block ES module loading in that mode.
