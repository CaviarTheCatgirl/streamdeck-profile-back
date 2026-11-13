# Changelog

## 1.0.1.0

**Fixes**
- Back / Board Back no longer flash the amber warning badge for a split second when a board opens. Pressing Back used to badge the board's keys just before leaving, and Stream Deck showed that leftover image on the next visit. Keys that are leaving now keep their image; the badge still appears when Back really would go somewhere unexpected or nowhere.

## 1.0.0.3 — first release

**Keys**
- **Open Board**: opens one of your boards on its first page, the last used page or a fixed page; shows the board's name on the key and follows renames.
- **Back**: returns to the normal profile you came from, however many boards deep.
- **Board Back**: one board back at a time; no depth limit; history survives restarts.

**Boards**
- 100 boards per deck model (15-key, Mini, XL, +, Neo, + XL), installed on first use, so unused ones never show up in the profile list.
- Boards keep their contents and plugin link through renames, plugin updates, uninstall and reinstall.

**Comfort and safety**
- Reopen the board you were on after a Stream Deck restart (option, on by default).
- Amber warning badge on Back / Board Back when Stream Deck would go somewhere unexpected or nowhere; the alert triangle shows immediately when Back can't go anywhere.
- Settings panels show where a key is and where pressing it leads, using your real profile names.
- Automatic board backups (start-up, version change, hourly when changed; newest 30 kept), restorable by double-click.
- Read-only access to Stream Deck's profile folder; no network access.

**Before release**
Built over several test builds on a real Stream Deck (7.5 / 7.6, Windows 11, MK.2). Removes the files those builds left in `%APPDATA%\ProfileBack` (event log, test reports) on first start.
