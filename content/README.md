# Event content: what goes where

This folder holds everything the game needs to know about the event: the places, the clues, the questions, the answers and the reference photos. Your team fills it in; Claude then loads it into the game.

## The files

| What | Where | Notes |
|---|---|---|
| Template | `event.template.yaml` | Do not edit. Copy it. |
| Your filled-in content | `event.yaml` | Copy of the template, with every `""` filled in. |
| Reference photos | `photos/<location>/unlock/` and `photos/<location>/q1/` | Real photos of the real objects. |

Steps:
1. Copy `event.template.yaml` to `event.yaml`.
2. Fill in every empty `""` and every `GDG{}`. Keep the indentation (spaces, no tabs).
3. Put the photos in the folders (see "Photos").
4. Tell Karan/Claude it is ready.

## How the game flows (so you know what each field is for)

1. Players check in at the **Lobby** (the base).
2. The Lobby shows them the **hint** and the **unlock** clue for the next location.
3. They find the place, go there, and **photograph** the object from the unlock clue. The AI checks it against your reference photos and unlocks the location.
4. Inside the location they answer **3 questions, one at a time**: Q1 is an image question, Q2 and Q3 are flag questions.
5. When all 3 are done they get the **location code** and the **next clue**.
6. They go back to the Lobby and **hand in the code**, which reveals the next location's hint and unlock clue.
7. When all three codes are handed in, the team has finished.

Locations are played in order: **1 Sports Complex, 2 Mechanical Block, 3 Library.**

## The fields

### `base` (the Lobby)
- `place`: the name players see. `description`: the short welcome text. `lat`/`lng`: map position (placeholder; the organiser sets the real one in the admin console).

### Each entry under `locations`
| Field | What it is | Example |
|---|---|---|
| `id` | Short internal name. Do not change. | `sports-complex` |
| `place` | Name players see once they find it. | `Sports Complex` |
| `quest_title` | A short catchy title for the stop. | `The Arena` |
| `hint` | A riddle or clue shown **at the Lobby** that helps players work out where this location is. Do not give the name away. | `Where sweat meets the scoreboard.` |
| `unlock.clue` | Tells players what to **photograph at the location** to unlock it. | `The basketball hoop nearest the entrance.` |
| `unlock.photos` | Folder with reference photos for that object. Leave as is. | `content/photos/sports-complex/unlock` |
| `questions` | Exactly 3, in order (see below). | |
| `location_code` | The secret code players get after finishing the location and hand in at the Lobby. Format `GDG{...}`. Unique for every location. | `GDG{SLAM_DUNK_42}` |
| `next_clue` | Shown after clearing the location; points players onward. For the last location, send them back to the Lobby. | `Where the machines roar.` |
| `lat`, `lng` | Map position. Placeholder: the organiser corrects it later. | |

### The 3 questions in every location
1. **Q1, `type: image`**: players photograph an object. The AI checks it.
   - `title`: the name of the question. `clue`: what to photograph. `photos`: reference photos folder (leave as is).
   - No flag and no link.
2. **Q2, `type: flag`** and 3. **Q3, `type: flag`**: players open a link, solve the question there, and type the answer flag here.
   - `title`: name of the question.
   - `note`: optional extra text shown to players (can stay empty).
   - `link`: the full `https://...` address of the real question page.
   - `flag`: the correct answer, in the form `GDG{...}`.

Flags: capital letters and spaces do not matter when players type them, but write them clearly, e.g. `GDG{OPEN_THE_GATE}`. Never reuse the same flag twice.

## Photos (important, the AI compares against these)
- Folders: `photos/<location>/unlock/` (the unlock object) and `photos/<location>/q1/` (the Q1 object). Six folders in total.
- Take **real photos with a phone, on campus, of the actual object**. Do not use images from the internet.
- **10 per folder is best, 3 is the minimum.** Vary the angle, the distance (close and far), and the light (sun, shade). Include the surroundings, not only a close-up.
- Use JPG or PNG. File names do not matter.
- The unlock object and the Q1 object should be **different things**, and each should be easy to tell apart from similar objects nearby.
- Choose objects that stay put and cannot be moved or taken (a fixed sign, a statue, a machine), not loose items.

## Checklist before telling us it is ready
- [ ] Every `""` in `event.yaml` is filled in.
- [ ] Every `GDG{}` has been replaced by a real, different flag or code.
- [ ] Every flag question has a working `https://` link.
- [ ] Each of the 6 photo folders has at least 3 (ideally 10) photos.
- [ ] Hints do not state the location's name outright.
- [ ] The last location's `next_clue` sends players back to the Lobby.

## IMPORTANT: this repository is public
Anyone, including players, could read the location codes, flags and photos. `event.yaml` and the photo files are listed in `.gitignore`, so they will not be committed by accident. To put them on GitHub, make the repository **private** first (GitHub > Settings > Danger zone > Change visibility), or share the filled file and photos privately (a zip or Drive link).
