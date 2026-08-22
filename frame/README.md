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

# Bird mic hosted at a public URL: point the frame straight at it.
./install.sh --image-url https://bird.onethreenine.net/frame.png?k=YOUR_FRAME_KEY
```

Each one enables SPI + I2C, installs the deps and a systemd timer, writes `~/.birdframe/config.toml`, and reboots once to bring SPI up. Full options live in [`config.example.toml`](config.example.toml).

The default layout matches the A5 opening in the frame listed above. If you use a different mat or a bare panel, set `opening` in `~/.birdframe/config.toml`; `0.7071` preserves the current A5 dimensions, while values up to about `0.98` use more of the panel.

Bird names are decided once, on the mic Pi: open the web admin and set **Bird names**, or put `COLLAGE_LABELS=on|off` in `birdnet.conf`. The collage, a frame rendering from that site, and a frame showing its published image all follow it — a flip shows up on the panel at the next check, no new bird needed. A single device can still pick its own in the collage's settings row, and a frame can override with:

```bash
birdframe-names on      # names on this frame, whatever the station says
birdframe-names off
birdframe-names auto    # follow the station again (the default)
birdframe-names status
```

Overriding is only possible on a frame that renders for itself. A frame pointed at a published image shows whatever the mic Pi drew, and the command says so instead of pretending.

Two consequences of "follow" worth knowing: a BirdWeather frame has no station, so `auto` there means the page's own default, names on; and a frame updated before its mic Pi sees no setting yet and likewise draws names until the mic Pi catches up. Use `birdframe-names off` if either is not what you want.

### Let the mic Pi render (publish mode)

Shooting the collage takes 70–120s and ~1GB of Chromium on a Zero 2 W. If your BirdNET mic is a Pi 4 or 5, let *it* render instead and have the frame just download the finished PNG.

On the **mic Pi**:

```bash
cd ~/BirdNET-Pi/frame
./install-publish.sh                     # every 5 min
./install-publish.sh --interval 15min    # easier on a Pi 3 or a busy box
```

It installs Playwright, publishes to `/frame.png` on the site Caddy already serves, and prints the URL to use next. No SPI, no panel driver, no reboot. You can also opt in during a fresh BirdNET-Pi install — inside `bash -c`, so the variable reaches the installer rather than `curl`:

```bash
FRAME_PUBLISH=15min bash -c "$(curl -s https://raw.githubusercontent.com/Twarner491/AvianVisitors/avian-visitors/newinstaller.sh)"
```

`FRAME_PUBLISH` takes an interval (`5min`, `1h`); `1`, `yes` or `true` mean "just use the default".

A tick that finds no new birds costs ~0.3s on a Pi 5 and never starts a browser; a full render is ~1.8s. The interval is a freshness knob, not a cost one — worst-case bird-to-panel latency is this interval plus the frame Pi's own 15-minute poll.

Then on the **frame Pi**, point the normal installer at that URL:

```bash
./install.sh --image-url http://<mic-pi>/frame.png
```

Any URL the frame Pi can resolve works — a LAN address, a [Tailscale](https://tailscale.com) MagicDNS name, a Cloudflare Tunnel hostname (see [`avian/forwarding/`](../avian/forwarding/)). If both Pis are on a tailnet, `tailscale serve --bg 80` on the mic Pi publishes it at `https://<node>.<tailnet>.ts.net/frame.png` with a real certificate and no port forwarding; `install-publish.sh` detects that and prints the tailnet URL for you.

Only the mic Pi decides when to re-render, so `frame.png` changes only when the birds do. The frame Pi asks for it conditionally and skips the panel refresh entirely when the image hasn't changed — no second guess at the same question on a second clock.

Retune titles in `/etc/birdframe/publish.env` and run `sudo systemctl start birdframe-publish`. Keys you add there survive re-runs. If the whole site is behind basic auth, set `FRAME_USER`/`FRAME_PASSWORD` there too — without them the change check gets a 401 every tick, which reads as "nothing new" and freezes the frame on one image.

To remove it: `./install-publish.sh --uninstall` (`scripts/uninstall.sh` discovers units by scanning `install_services.sh`, so it cannot see this one).

Bird names on the published frame follow the station's **Bird names** setting like everything else, and the publisher re-renders when it changes. `FRAME_BIRD_NAMES=on|off` in `publish.env` forces it for the publisher alone, which is rarely what you want.

BirdWeather mode renders on the Pi from this repo's illustrations on GitHub, so there is no image set to copy over. ZIP codes with no station nearby fall back to the closest ones. If you are far from any BirdWeather station, add `--ebird-key <key>` (a free key from [ebird.org/api/keygen](https://ebird.org/api/keygen)) and the frame fills from eBird sightings instead.

The bundled illustrations center on the western U.S. If birds near your ZIP aren't in the set you cloned, the installer flags them and the frame skips them until they exist. To generate them, run [`generate_illustrations.py`](generate_illustrations.py) on a laptop or workstation (it uses the same rembg cutout as the rest of the pipeline, which the Pi can't fit in memory), passing your ZIP and a paid Google Gemini key, then commit the new cutouts or copy them to the Pi:

```bash
python3 generate_illustrations.py --zip 10001 --gemini-key YOUR_GEMINI_KEY
```

It generates only the species you're missing; `--country` and `--sample` carry through for non-US postcodes or a wider region.
