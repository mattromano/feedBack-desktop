# Rock Band release of feedBack

The `release/rockband` branch of this repo builds the ready-made feedBack app with the Rock Band /
Guitar Hero package included. People download one app from
[Releases](https://github.com/mattromano/feedBack-desktop/releases); nothing else to install.

## What goes in

`scripts/build-common.sh` on this branch bundles:

| Part | Repo | Branch |
|---|---|---|
| core | mattromano/feedBack | `feature/build-a-band-stage` |
| 5-Fret | mattromano/feedBack-plugin-five-fret | `main` |
| RockHeroSmith | mattromano/feedBack-plugin-rockherosmith | `feature/build-a-band-stage` |
| Drums | mattromano/feedBack-plugin-drums | `feature/build-a-band-stage` |
| Lyrics Karaoke | mattromano/feedBack-plugin-lyrics-karaoke | `feature/build-a-band-stage` |
| everything else | the same plugins as `custom` | as listed there |

## Shipping a bug fix

1. Fix it on the branch in the table above (PR or push), as usual.
2. `./scripts/release-rockband.sh 0.3.1` (the next version; versions only go up).
3. The tag starts the Build workflow (Mac, Windows, Linux, ~20-30 min) and publishes the release.
4. Installed apps see it in Settings → Updates (stable channel) and offer a restart.
   - Windows: updates install in place.
   - Mac: the app is not signed or notarized (no Apple Developer secrets on this repo), so macOS may
     block the in-place update; download the new zip from Releases instead. Adding the Apple secrets
     (`APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`) makes Mac
     updates install in place too.

Only desktop changes (Electron, native audio) need commits on this branch; core and plugin fixes
are picked up from their branches by the next tag. To bring in new `custom` desktop work:
`git merge origin/custom` on `release/rockband`.

`./scripts/release-rockband.sh 0.3.1 --dry-run` shows what would be tagged without pushing.

## First run for players

- Mac: unzip, move to Applications, right-click → Open the first time (unsigned app).
- Windows: run the setup `.exe` (SmartScreen: More info → Run anyway).
- Plug in an Xbox or other standard controller; plastic guitars and kits are set up on the 5-Fret /
  Drums controls screens.
- Songs: feedpak (`.sloppak`) packs. Rock Band 5-fret and drum charts are added to a library with
  `scripts/drums_library.py` from the core repo (see the release notes).
