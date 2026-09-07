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

**Waveshare panel instead of an Inky:** the [13.3" e-Paper HAT+ (E)](https://www.waveshare.com/13.3inch-e-paper-hat-plus-e.htm) carries the same EL133UF1 Spectra 6 panel but is a different board, so the Inky driver needs a few retargets before it works. It has no EEPROM, so `inky.auto()` can't detect it — set `panel = "waveshare13in3e"` in `~/.birdframe/config.toml`.

The HAT's control pins (BCM) and SPI bus differ from the Inky's:

| Signal | GPIO |
|--------|------|
| CS, left half | 8 |
| CS, right half | 7 |
| DC | 25 |
| RST | 17 |
| BUSY | 24 |
| PWR, panel power-enable | 18 |

These sit on SPI0 (SCK 11, MOSI 10); the two CS lines are SPI0's CE0/CE1. Three things about this panel aren't obvious, and the frame handles them:

- **BUSY is active-low** (low = refreshing, high = idle). The stock Inky driver waits the other way, so it returns before the ~19 s refresh actually finishes. The frame waits on the real polarity.
- **The init values and reset differ** from the Pimoroni ones. This panel wants Waveshare's own `AN_TM`/`CDI`/`PSR`/boost values and a double reset pulse; the frame sends those.
- **The panel is powered through PWR** (a 1-0-1 pulse to turn it on, dropped again after the refresh) and **deep-slept after each refresh**, per Waveshare's manual.

**Wiring the panel — read this before plugging anything in.** Two rules, both learned the hard way:

1. **Ribbon orientation: silver contacts face DOWN, towards the board**, at every FFC connection (panel ribbon into the HAT's connector, and any cable into the Pi's header adapter). Contacts up = pins mis-map and the panel does nothing.
2. **Never put the Waveshare "e-Paper Adapter (B)" extension board in the chain.** It is built for the older 13.3" e-Paper **(B)** panel family and does not pass the (E) panel's pins through — BUSY lands on GND, so the panel never refreshes no matter how well it is seated. The (E) panel's ribbon connects **directly to the HAT+ (E)**.

The panel ribbon reaches the HAT when the HAT is seated on the Pi's 40-pin header. If you need the panel farther from the Pi, do **not** extend on the panel side. Instead, keep the panel ribbon direct into the HAT and move the *HAT itself* off the Pi with the HAT's 10-pin cable: HAT → 10-pin breakout cable → Pi header pins (VCC to 3.3 V pin 1, GND to pin 6, DIN to GPIO10/pin 19, CLK to GPIO11/pin 23, CS_M to GPIO8/pin 24, CS_S to GPIO7/pin 26, DC to GPIO25/pin 22, RST to GPIO17/pin 11, BUSY to GPIO24/pin 18, PWR to GPIO18/pin 12).

**A refresh is verified, not assumed.** The frame samples BUSY while a refresh runs and counts it as real only if BUSY toggles idle → busy → idle. A controller that ignores the refresh command (wedged or unpowered) leaves BUSY stuck, so the frame raises `PanelRefreshError` rather than silently leaving the old image up. With `auto_power_cycle = true` (default) it reboots once to power-cycle a wedged controller; set it to `false` to only log.

To confirm a real refresh is happening, push a test card from the Pi and watch BUSY:

```bash
python3 _panel_test.py --times 3    # three in a row proves it doesn't wedge
```

If a panel never refreshes at all — even when driven by Waveshare's own reference demo rather than this code — the fault is in the hardware (HAT / panel / connection), not in the frame. To narrow it down before touching drivers, run the BUSY oracle on the Pi (`sudo python3 tools/busy_oracle.py`): it distinguishes a floating BUSY (HAT-to-Pi chain broken), a BUSY shorted to GND (wrong adapter / flipped FFC), and a live controller (drives BUSY high when idle).

Bird names are off on the frame by default. Turn them on or off at any time; the command saves the preference and requests an immediate refresh:

```bash
birdframe-names on
birdframe-names off
```

Set `shoot_title = ""` in `~/.birdframe/config.toml` if you want to hide only the frame title.

For an `--image-url` frame, the command adds `labels=1` or `labels=0` to the source URL. The source must honor that setting; otherwise its image will not change.

BirdWeather mode renders on the Pi from this repo's illustrations on GitHub, so there is no image set to copy over. In ZIP mode, postal codes with no station nearby fall back to the closest ones. If you are far from any BirdWeather station, add `--ebird-key <key>` (a free key from [ebird.org/api/keygen](https://ebird.org/api/keygen)) and the frame fills from eBird sightings instead. Exact station mode has no geographic or eBird fallback.

The bundled illustrations center on the western U.S. If birds for your ZIP or station aren't in the set you cloned, the installer flags them and the frame skips them until they exist. To generate them, run [`generate_illustrations.py`](generate_illustrations.py) on a laptop or workstation (it uses the same rembg cutout as the rest of the pipeline, which the Pi can't fit in memory), passing your source and a paid Google Gemini key, then commit the new cutouts or copy them to the Pi:

```bash
python3 generate_illustrations.py --zip 10001 --gemini-key YOUR_GEMINI_KEY
# or for one station
python3 generate_illustrations.py --station-id 12345 --gemini-key YOUR_GEMINI_KEY
```

It generates only the species you're missing. `--country` supports non-US postcodes, and `--sample` controls how many top species are checked.
