# Privacy statement

ShareGlass is designed so that routine file inspection does not require a server.

## Web application

The published static application processes selected files in the browser tab. The project does not implement file upload, authentication, analytics, advertising, session replay, or telemetry endpoints. Report exports and safe copies are generated with browser APIs and downloaded directly to the user's device.

Normal hosting infrastructure may receive standard requests for static HTML, CSS, JavaScript, images, samples, and service-worker assets. Those requests do not contain the selected file.

## Optional C2PA validation

Cryptographic Content Credentials validation is user-initiated. On the first click, the web app fetches the pinned official `@contentauth/c2pa-web` JavaScript module and WebAssembly binary from jsDelivr. The inspected file remains a local `Blob` passed to the SDK in the same page. Users who require no third-party connection can skip the feature or self-host the SDK assets.

## CLI

The CLI reads local paths and writes only the output/report paths requested by the user. It has no network code.

## Reports

Reports can include evidence such as author names, URLs, coordinates, software names, and internal package paths. Treat exported JSON or Markdown reports as potentially sensitive. The share-card feature intentionally hides the source filename and does not print raw evidence.
