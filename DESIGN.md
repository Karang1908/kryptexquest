---
name: Kryptex Quest
description: A chunky mobile adventure game at night: outlined candy keys, studded panels, hex medals and treasure in the four Google colours.
colors:
  ink: "#070a22"
  night: "#0a0f33"
  panel-top: "#1d2878"
  panel-bottom: "#141c5a"
  raised: "#1b2670"
  recess: "#070b2a"
  text: "#f4f6ff"
  muted: "#aab5e6"
  blue: "#4285f4"
  blue-hi: "#7db1ff"
  blue-lo: "#2a62d6"
  red: "#ea4335"
  red-hi: "#ff8a7e"
  red-lo: "#cf2a1d"
  yellow: "#fbbc04"
  yellow-hi: "#ffe066"
  yellow-lo: "#f29a00"
  green: "#34a853"
  green-hi: "#6fdc8c"
  green-lo: "#1f8a3d"
  locked: "#8189bd"
typography:
  display:
    fontFamily: "Lilita One, Google Sans, system-ui, sans-serif"
    fontWeight: 400
    letterSpacing: "0.01em"
  body:
    fontFamily: "Google Sans Text, Google Sans, system-ui, sans-serif"
    fontWeight: 400
  code:
    fontFamily: "ui-monospace, SF Mono, Menlo, monospace"
rounded:
  key: "16px"
  panel: "22px"
  sheet: "28px"
components:
  key-primary:
    backgroundColor: "{colors.blue}"
    textColor: "#ffffff"
    rounded: "{rounded.key}"
    height: "52px"
  key-go:
    backgroundColor: "{colors.green}"
    textColor: "#ffffff"
    rounded: "{rounded.key}"
  panel:
    backgroundColor: "{colors.panel-bottom}"
    textColor: "{colors.text}"
    rounded: "{rounded.panel}"
  slot:
    backgroundColor: "{colors.recess}"
    textColor: "{colors.text}"
    rounded: "14px"
---

## Overview
Night Quest. A mobile adventure game skin: everything has a thick ink outline, buttons are candy keys with a lip that press down 5px, panels are studded night-blue slabs, fields are dark recessed slots, status is a hex medal. Success always pays out (banner, sound, chest). The four Google colours are the four candies and always carry state: grey = found but locked, blue = open, green = cleared, red = the base, yellow = go / attention.

## Colors
Ink `#070a22` outlines everything. Night-blue panels with a top highlight. Each candy has hi/base/lo/lip so gradients and lips stay consistent. Use tints (`-ink` variants) for coloured text on dark. Never add new hues.

## Typography
Lilita One for titles, buttons, numbers and names, outlined with a heavy ink stroke when set large. Google Sans Text for body copy (brand font). Monospace only for flags, location codes and coordinates.

## Layout
Phone first: full-bleed 3D map, a HUD row (avatar medallion, gem tracker, GPS lamp), an objective plate at the bottom, a bottom sheet "quest scroll" for everything else with all questions open at once. Console: the same skin on a laptop grid, one navbar, one view per tab.

## Elevation & Depth
No soft glass. Depth is a hard lip under keys and panels (`0 4-5px 0 ink`), an inner top highlight, and a soft cast shadow. Keys press by translating down the lip height.

## Shapes
Rounded 16-28px, hex for medals and numbers, circles for avatars and round buttons, ribbons for headings.

## Components
- Keys: blue primary, green go/submit, yellow reward/link, red close/destructive, indigo secondary.
- Panel and recess: studded slab and dark slot.
- Hex medal: ink hex, gradient fill, white game icon; states by colour.
- Ribbon, pill tag, chunky bar, gem tracker.
- Reward modal: rays, a pop-in chest or medal, loot in a slot, a green OK key.
- Quest banner: dark-blue plate with a medal and a short line, with a sound.
- Icons: game-icons.net glyphs through CSS masks (credited in `assets/CREDITS.md`), plus a small drawn UI set in `js/icons.js`.

## Do's and Don'ts
- Do outline everything in ink and give every key a lip.
- Do make wins feel big: sound, banner, medal, chest.
- Do keep body text 15px+ and tap targets 44px+.
- Don't use gradient text, thin 1px borders, glass blur or neon glow.
- Don't use emoji as icons.
- Don't use the lip shadow on anything that does not press.
