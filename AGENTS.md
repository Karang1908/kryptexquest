# Kryptex Quest repository notes

- This repository currently contains a web prototype with no package install step. Serve the root with `python3 -m http.server 4173` and open `http://localhost:4173`.
- In this workspace the sandbox blocks opening a local socket (`PermissionError: [Errno 1] Operation not permitted`); browser verification of the server may require an escalated local command.
- `index.html` defines the app shell and dialogs. `styles.css` holds responsive styling. `app.js` holds sample stations, state, UI actions, and the optional MapLibre map. Keep changes small and follow the existing plain JavaScript pattern.
- `CONTEXT.md` is the product and decision log. Update it when the game rules, campus data, assets, or implementation status change.
- The campus center is real; the four stop pins are provisional examples. Do not present them as surveyed or event-ready coordinates.
- The photo approval action is a labeled simulation. Never describe it as real AI verification or send photos to a third party without an explicit product decision.
- Test the full unlock → three puzzles → handoff flow in the browser after changing quest state logic. Test desktop and phone widths after changing layout.
- MapLibre JS/CSS, OpenFreeMap tiles, Google Fonts, and `<model-viewer>` load remotely. The illustrated map and CSS avatar portraits are fallbacks when remote services are unavailable. The two character GLBs live in `assets/`.
- MapLibre's remote stylesheet applies `position: relative` to the map element after local CSS loads. Keep the `#map.map-canvas` size/position override or the map collapses to zero height.
