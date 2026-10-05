# AvianVisitors e-ink frame

*The last 24h of birds, framed on the wall by your window.*

A [Pimoroni Inky Impression 13.3"](https://amzn.to/4xlAWr3) (Spectra 6) mirroring the live collage. A Pi screenshots the site, mats it onto an A5 opening, and pushes to the panel, refreshing only when the birds change. Build one of your own at [theodore.net/projects/AvianVisitors#frame-ous](https://theodore.net/projects/AvianVisitors/#frame-ous).

![](https://theodore.net/assets/images/AvianVisitors/final.jpg)

---

### BOM

| Qty | Description | Price | Link |
|-----|-------------|-------|------|
| 1 | Raspberry Pi 3 A+ or Zero 2 W | ~$25-35 | [Amazon](https://amzn.to/49Xp58I) |
| 1 | 13.3" E Ink Display     | $299.99 | [Amazon](https://amzn.to/4xlAWr3) |
| 1 | A4 Wood Photo Frame    | $21.99 | [Amazon](https://amzn.to/3RWFbJE) |
| 1 | Long, Flat Micro USB Cable    | $7.99 | [Amazon](https://a.co/d/0a59rKSk) |
| 1 | Flat USB Brick    | $7.59 | [Amazon](https://amzn.to/3S4CtSs) |
| | **Total** | **~$365** | | |

The 3 A+ and Zero 2 W are both tested and set up identically; any Pi with the 40-pin header that runs 64-bit Raspberry Pi OS works. The printed backing pressure-fits either board.

CAD + 3d print files can be found in [`hardware/`](hardware/).

### Kits

I offer the frame and the bird mic as separate electronics kits. I put up a store for some of my open-source projects and will soon be able to offer kits cheaper than buying all the components individually, once I start buying in bulk.

- [Frame kit](https://theodore.net/store/avian-visitors/)
- [Bird mic kit](https://theodore.net/store/avian-mic/)

---

## 1. Flash the SD card

Flash an sd card with Raspberry Pi OS Lite (64-bit) via [Raspberry Pi Imager](https://www.raspberrypi.com/software/). In the customisation dialog set:

- Username
- WiFi SSID + password
- Hostname: `birdpic`
- Enable SSH with password auth

Then install in Pi and power up.

## 2. Run the installer

```bash
ssh <your-username>@birdpic.local
sudo apt update && sudo apt install -y git
git clone https://github.com/Twarner491/AvianVisitors
cd AvianVisitors/frame
```

Pick how the frame gets its birds:

```bash
# Pair with your bird mic on the same network (birdnet.local). The default.
./install.sh

# No microphone: draw the collage from BirdWeather for any ZIP code.
./install.sh --bird-weather --zip 94107

# No microphone: follow one public BirdWeather station exactly.
./install.sh --station-id 12345

# Bird mic hosted at a public URL: point the frame straight at it.
./install.sh --image-url https://bird.onethreenine.net/frame.png?k=YOUR_FRAME_KEY
```

Each one enables SPI + I2C, installs the deps and a systemd timer, writes `~/.birdframe/config.toml`, and reboots once to bring SPI up. Full options live in [`config.example.toml`](config.example.toml). The station ID is the public number at the end of a BirdWeather station-page URL, not its upload token. ZIP mode summarizes nearby stations and can use fallbacks; station mode shows only that station and fails rather than substituting another source.

The default layout matches the A5 opening in the frame listed above. If you use a different mat or a bare panel, set `opening` in `~/.birdframe/config.toml`; `0.7071` preserves the current A5 dimensions, while values up to about `0.98` use more of the panel. This one setting scales a fixed 1:sqrt(2) opening, not width and height independently. For a B5 opening, `0.84` is a useful starting point, but check it against your physical mat.

Bird names are off on the frame by default. Turn them on or off at any time; the command saves the preference and requests an immediate refresh:

```bash
birdframe-names on
birdframe-names off
```

Set `shoot_title = ""` in `~/.birdframe/config.toml` if you want to hide only the frame title.

For an `--image-url` frame, the command adds `labels=1` or `labels=0` to the source URL. The source must honor that setting; otherwise its image will not change.

When updating a paired mic and frame, update both. The frame waits for the mic's collage to finish loading before capturing it. An older mic frontend cannot confirm this, so the frame keeps its previous image and logs an update reminder. Capture now requires Pillow as well as Playwright, including standalone `shoot.py` use.

Update the mic through **Tools > Pull latest**. On the frame Pi, pull the update and request a fresh capture:

```bash
cd ~/AvianVisitors/frame && git pull --ff-only && \
  .venv/bin/pip install -r requirements-shoot.txt && \
  .venv/bin/python display.py --config ~/.birdframe/config.toml --force
```

If Git reports local edits, preserve them and resolve that before updating.

Slow, incomplete, or corrupt artwork and a changing collage leave the last good frame and refresh state untouched. Capture validates the exact PNG/WebP responses used by the browser, then combines their artwork with small transparent captures of the titles and labels. If artwork validation repeatedly fails, check the source illustration before retrying; preserve custom artwork and do not delete the previous frame. Desktop and container tests do not replace a capture check on the frame Pi.

BirdWeather mode renders on the Pi from this repo's illustrations on GitHub, so there is no image set to copy over. In ZIP mode, postal codes with no station nearby fall back to the closest ones. If you are far from any BirdWeather station, add `--ebird-key <key>` (a free key from [ebird.org/api/keygen](https://ebird.org/api/keygen)) and the frame fills from eBird sightings instead. Exact station mode has no geographic or eBird fallback.

The bundled illustrations center on the western U.S. If birds for your ZIP or station aren't in the set you cloned, the installer flags them and the frame skips them until they exist. To generate them, run [`generate_illustrations.py`](generate_illustrations.py) on a laptop or workstation (it uses the same rembg cutout as the rest of the pipeline, which the Pi can't fit in memory), passing your source and a paid Google Gemini key, then commit the new cutouts or copy them to the Pi:

```bash
python3 generate_illustrations.py --zip 10001 --gemini-key YOUR_GEMINI_KEY
# or for one station
python3 generate_illustrations.py --station-id 12345 --gemini-key YOUR_GEMINI_KEY
```

It generates only the species you're missing. `--country` supports non-US postcodes, and `--sample` controls how many top species are checked.
