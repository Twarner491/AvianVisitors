# Avian Visitors V1.1

Avian Visitors v1.1 brings durable station choices together on a quieter Settings page, restores the classic illustrated Atlas cards, and makes local access, BirdWeather sharing, and nightly backups explicit choices.

![Settings showing icon theme choices, the bird-name switch, Atlas preferences, station name, and detection tuning](https://github.com/Twarner491/AvianVisitors/releases/download/v1.1.0/settings-preferences.jpg)

*Theme, bird-name visibility, Atlas preferences, and station identity now live together in Settings.*

## Local controls stay local

The station owner can require a password for Settings, System, Logs, and Tools on the local network. The collage, Stats, Atlas, public recordings, and bird postcards remain available. Enabling the gate closes the microphone stream and keeps Icecast blocked across service starts and reboots until the station returns to trusted mode.

Password setup, password changes, recovery, idle locking, cross-tab session replacement, downloads, and service actions all use the same root-managed policy state. The password verifier and policy epoch live outside `birdnet.conf` and outside station backups, so a restored config cannot roll the local access policy backward.

![The Avian Visitors menu showing the administrator password field over the public Atlas](https://github.com/Twarner491/AvianVisitors/releases/download/v1.1.0/admin-lock.jpg)

*The locked drawer keeps the public bird pages visible while administrator sections stay hidden.*

## BirdWeather sharing is an explicit choice

BirdWeather sharing now has a dedicated Settings control. New stations start with sharing and full-recording uploads off. A BirdWeather station is still created in a BirdWeather account, and its station token is then entered in Avian Visitors. Once the token verifies, the field is cleared and replaced by compact actions to view the public station or forget the token before entering another one.

Detection sharing, full source-recording uploads, and the local human-sound filter are separate choices. BirdNET still analyzes the audio; the filter then checks 10, about 60, about 120, or about 180 model candidates at levels 0 through 3. A human match suppresses local bird detections for that three-second window and its neighbors, but it does not redact a full recording the owner separately chooses to upload. Existing BirdWeather stations keep their prior sharing behavior during migration; new stations do not upload until the owner opts in.

![BirdWeather sharing expanded in Settings with the station link, token action, and privacy controls](https://github.com/Twarner491/AvianVisitors/releases/download/v1.1.0/settings-birdweather.jpg)

*BirdWeather consent, audio upload, the local human filter, and the view-or-forget token actions are visible in one compact disclosure.*

## Nightly Drive backup belongs with retention

Nightly Drive backup has moved from Tools to Settings beside BirdWeather and recording retention. Its row tooltip gives the first-use sequence, while the compact details place `rclone config` beside Set up archive or Check again. Once configured, the same disclosure holds run, schedule, and verified cleanup controls. Enabling or running an archive first forces recording preservation and safe full-disk behavior through the same serialized Settings writer, so an older autosave cannot silently re-enable deletion.

Tools is now narrower: it contains service and update actions plus the two direct data downloads, detections as CSV and recordings as an archive.

![Nightly Drive backup setup expanded beneath BirdWeather and local access](https://github.com/Twarner491/AvianVisitors/releases/download/v1.1.0/settings-archive.jpg)

*Nightly backup setup stays compact beside the recording-retention controls.*

![Tools showing the detections and recordings downloads](https://github.com/Twarner491/AvianVisitors/releases/download/v1.1.0/tools-data.jpg)

*The data section in Tools is now only the two downloads.*

## Atlas can be stamps or classic cards

The stamp collection remains the default Atlas. A browser preference in Settings can instead restore the classic illustrated cards from the last pre-stamp Atlas. The current Life List, Family, Name, and Frequency arrangements, selected time window, scrolling, deep links, and field postcard all remain the same.

![Avian Atlas using the restored classic illustrated cards](https://github.com/Twarner491/AvianVisitors/releases/download/v1.1.0/atlas-classic.jpg)

*Classic cards use the original cutout presentation without giving up the current Atlas controls.*

![A classic Atlas bird opened in the current field postcard](https://github.com/Twarner491/AvianVisitors/releases/download/v1.1.0/atlas-classic-postcard.jpg)

*The current postcard layout remains, with no stamp in its illustration corner when it was opened from a classic card.*

The classic renderer also fixes an older event-listener problem that could make card audio start or stop more than once after repeated sorts and filters. Changing layouts stops detached playback before replacing the grid.

## Settings is smaller and more direct

The station name now edits the canonical `SITE_NAME` used by BirdNET-Pi. Avian Visitors applies it to the collage and browser title, while the local frame can inherit it unless the frame has an explicit title override. The theme picker uses icons for system, light, and dark modes, with an accessible name and tooltip for each choice. Bird-name visibility uses the same switch pattern as the other binary preferences. Always show full atlas and Classic Atlas cards remain beside them.

Local access, BirdWeather, Nightly Drive backup, recording preservation, and full-disk behavior share one final section. As the longer page scrolls, the Settings title moves into the fixed header without shrinking or covering the controls. Details open smoothly, segmented selectors render correctly on first reveal, tooltips support pointer, keyboard, touch, and Escape, and focus treatments remain quiet in light and dark themes.

## Reliability, privacy, and installation

This release removes BirdWeather credentials from diagnostic archives, copied service definitions, old first-run config duplicates, and command traces. Diagnostic collection now starts from a fresh private directory, redacts known secrets without evaluating the station config, and writes one private archive atomically.

BirdWeather requests are bounded, do not inherit ambient proxy or netrc credentials, do not follow redirects, and do not print the station token or coordinates in errors. Detections-only mode never opens a source recording. Full audio sharing is a separate consent switch.

The Icecast start guard is root-owned and evaluated by systemd. It does not depend on the Icecast XML path, port, or bind address. Policy transitions preserve whether the service was previously active, close established listeners, and restore only verified trusted-mode state.

## Updating an existing station

Use **Tools > Pull latest** for a normal update after v1.0.0. The terminal path remains available:

```bash
cd ~/BirdNET-Pi
./scripts/update_birdnet.sh
```

The updater migrates existing local password and BirdWeather settings without turning new sharing choices on. Existing generated artwork, masks, dimensions, recordings, and archive configuration remain local.

New stations can continue to use the installer in the [README](https://github.com/Twarner491/AvianVisitors#readme).

## Built with the people using it

This release again grew directly from people running Avian Visitors on their own stations.

[@mellow65](https://github.com/mellow65) exposed the unclear local menu-password setup in [#71](https://github.com/Twarner491/AvianVisitors/issues/71), which led to the complete native setup, access, recovery, and session flow.

[@dskaplan](https://github.com/dskaplan) proposed and prototyped a per-browser stamps versus cutouts choice in [#72](https://github.com/Twarner491/AvianVisitors/pull/72). The released version keeps that core idea while preserving the current sort, window, postcard, and audio behavior.

[@jonnywright](https://github.com/jonnywright) reported the missing stamp treatment in [#75](https://github.com/Twarner491/AvianVisitors/issues/75). [@Kimfamous](https://github.com/Kimfamous) documented clipped stamp-label descenders on Firefox for Android in [#76](https://github.com/Twarner491/AvianVisitors/issues/76); those labels now reserve space below the baseline and have a focused regression check.

[@VRConservation](https://github.com/VRConservation) supplied detailed Raspberry Pi 5 traces for the `tmp.mount` installation failure in [#78](https://github.com/Twarner491/AvianVisitors/issues/78) and the direct ALSA microphone conflict in [#79](https://github.com/Twarner491/AvianVisitors/issues/79). Those reports are covered by the installer and recording-service regression work included here.

[@PhantomPhoton](https://github.com/PhantomPhoton) caught the incorrect Woodhouse's Scrub-Jay flight illustration in [#80](https://github.com/Twarner491/AvianVisitors/issues/80). The corrected paired artwork ships with this release.

Thank you to everyone who tested the first release on a different Pi, browser, microphone, screen size, and local-network setup.
