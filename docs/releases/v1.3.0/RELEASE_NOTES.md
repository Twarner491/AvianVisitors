# Avian Visitors v1.3.0

Avian Visitors v1.3 makes illustration bundles work across the station, BirdFrame, and [avianvisitors.com/bundles](https://avianvisitors.com/bundles). Browse a set, install it, or export and share your own without rebuilding Avian Visitors.

![The Avian Visitors Collage using the Evolutionary Impressionist bird bundle](https://github.com/Twarner491/AvianVisitors/releases/download/v1.3.0/evolutionary-impressionist-station.jpg)

*The Collage using Evolutionary Impressionist, an optional 333-bird set for Western North America.*

## Choose artwork in Settings

**Bird bundle** now lives directly below Theme in Settings. Open it to browse the same bundle list found at [avianvisitors.com/bundles](https://avianvisitors.com/bundles), search by place or bundle, and narrow the list by region.

Downloaded bundles stay at the top and carry a small download badge. **Refresh local birds** reapplies a changed location to the active downloaded set. The full catalog link opens in a new tab, leaving the station in place.

On phones, the catalog opens as a tall bottom sheet with a drag handle. On larger screens, it opens over Settings and keeps the station theme.

![Evolutionary Impressionist selected as the active Bird bundle in station Settings](https://github.com/Twarner491/AvianVisitors/releases/download/v1.3.0/station-impressionist-active.jpg)

*Settings shows the active Bird bundle.*

## Browse and share bundles

Bundle rows stay compact until opened. Each expanded row keeps the same collage and details layout, including sets with one illustration. The catalog shows the creator, coverage, style, version, license, download size, and source.

To share a set made on your station, open **Tools > Your data > Export bundle**. Review the local illustrations and download one upload-ready ZIP. Sign in with GitHub at [avianvisitors.com/bundles](https://avianvisitors.com/bundles), upload the ZIP, and follow its review status under **Your bundles**. Changes-requested and published bundles remain available there.

Uploads support archives up to 768 MiB and 1,500 PNG objects, with limits of 4 MiB per image, 640 MiB of expanded content, and 1,000 species.

Uploads stay private while file, image, and manifest checks run. Bird and style quality findings are advisory; technical checks, supported licensing, complete clean safety moderation, and explicit maintainer approval remain required. The station never uploads a bundle automatically.

## One command for a station or BirdFrame

After SSHing into either device, run the same command with the bundle ID copied from the catalog:

```bash
sudo avian-bundle use '<BUNDLE_ID>'
```

Each installable row keeps **Use on my local station** as its main action. The adjacent command button opens this line and copies it immediately.

With a saved location, the device downloads only the bundle's birds expected there throughout the year. Without a location, it downloads the full set. Add `--all-species` for an explicit full download.

The installer verifies the full manifest and each selected image, then switches artwork atomically. A failed install leaves the current bundle in place. Frame captures wait for complete images before updating the panel. Repeating the command is safe.

![A wall-mounted wooden BirdFrame displaying Evolutionary Impressionist birds on its e-ink screen](https://github.com/Twarner491/AvianVisitors/releases/download/v1.3.0/evolutionary-impressionist-frame.jpg)

*Evolutionary Impressionist on BirdFrame. Photo by Teddy Warner.*

## Two official sets

Japanese Woodblock remains the included default. Evolutionary Impressionist adds bright, loose gestures while covering the same 333 Western North American species. Both carry the Official badge.

Evolutionary Impressionist is built on Matt DesLauriers's work, *Synthetic Gestures: An Evolutionary Sketching Machine*. SIREN paths evolved with sNES while CLIP compared each bird with its Japanese Woodblock cutout before human review.

The twelve cutouts used by the two official catalog collages total 3.44 MB, down from 5.60 MB. Their visible pixels, dimensions, masks, and handwritten labels are unchanged. A collage loads only when its row opens.

## Bundles contain pictures, not apps

The station sends only its broad region to the catalog, never its latitude or longitude. Bundle files live in the managed Avian Visitors data library and stay in place during updates and reinstalls. Contributor repositories, scripts, and executables are never installed or run.

If the community catalog is unavailable, the included Japanese Woodblock set, checked official listings, and downloaded bundles remain available locally.

## Updating an existing station

Use **Tools > Pull latest** or the [documented updater](https://github.com/Twarner491/AvianVisitors/blob/v1.3.0/README.md#updating-an-existing-station). The station keeps its current illustration choice during the update.

After updating, open **Settings > Bird bundle** to see the current set or choose another one.

## Built with the people using it

The regional collection exists because community members made artwork for places the original set did not cover: [@SupraBitKid](https://github.com/SupraBitKid), [@theskyisthelimit](https://github.com/theskyisthelimit), [@bassrelic](https://github.com/bassrelic), [@RoqueAlonso](https://github.com/RoqueAlonso), [@jonnywright](https://github.com/jonnywright), [@lloydalexporter](https://github.com/lloydalexporter), [@peterdeboer-nl](https://github.com/peterdeboer-nl), [@TheWillni](https://github.com/TheWillni), and [@opurtell](https://github.com/opurtell). [@cdkl](https://github.com/cdkl) contributed original Eastern North American artwork later refined into the included set.

Nothing moves into the reviewed catalog automatically. Each maintainer keeps control of the files, coverage, attribution, license, style, and source link for their work. Thank you to everyone who made, shared, and tested artwork for a different part of the world.
