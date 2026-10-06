# Event content: how to fill it in

1. Copy `event.template.yaml` to `event.yaml` and fill in every empty `""`.
2. Add photos to the folders in `content/photos/` (3 to 10 per folder, 10 is best, real photos of the real object from
   different angles). `unlock/` = the photo players take to unlock the location. `q1/` = the first question's photo.
   
3. Commit and tell Karan/Claude. Claude loads it into the game and checks it.

Each location needs: a name, a hint (shown at the Lobby), an image unlock clue + photos, question 1 (image) + photos,
3 questions: Q1 image, Q2 and Q3 flag (each flag question needs a link and a flag), a location code (`GDG{...}`), and a next clue.
Locations are in walking order. The map positions are placeholders; organisers set the real ones in the admin console.

## IMPORTANT: this repository is public
Location codes and flags in `event.yaml` would be readable by anyone, including players. Do **not** commit the real
`event.yaml` or photos here unless the repository is made **private** first (GitHub > Settings > Danger zone >
Change visibility). Until then, keep `event.yaml` and `content/photos/` local/shared privately: they are in `.gitignore`.
