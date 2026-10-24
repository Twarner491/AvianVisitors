# Audio: sharing one microphone, and picking the right device name

Two things about the capture device bite almost everyone who runs a USB
microphone on a headless Pi. Neither produces a useful error message.

> **All card names, rates, channel counts and formats below are examples.**
> They match one common USB microphone. Check each value against your own
> hardware (`arecord -L`, and the hardware-parameter check further down)
> before you copy it.

Several commands below run as the **station user**: the account the services
run as, which is `BIRDNET_USER` in `/etc/birdnet/birdnet.conf`. Set it once:

```bash
STATION_USER=$(sed -n 's/^BIRDNET_USER=//p' /etc/birdnet/birdnet.conf)
echo "$STATION_USER"
```

## Running the live stream and the analysis at the same time

`birdnet_recording.sh` and `livestream.sh` both open `$REC_CARD`:

```bash
arecord -D "${REC_CARD}" …                    # birdnet_recording.sh
ffmpeg -f alsa -i ${REC_CARD} …               # livestream.sh
```

Most USB audio devices allow exactly one capture client, so two services
cannot both open the raw device. The live stream therefore refuses to start
when `REC_CARD` is a raw `hw:` or `plughw:` device (`livestream.sh --check`
fails, and the unit is skipped): the recording service keeps the card and you
get no live stream. A shared device with its own name is not `hw:`/`plughw:`,
so the live stream is allowed to start and both services read from it.

You do not have to give up the live stream. ALSA ships `dsnoop`, which splits
one capture stream between several readers.

### 1. Back up any existing `/etc/asound.conf`

Other things on the Pi (a default device, an equalizer, a second sound card)
may already be configured there. Do not overwrite it:

```bash
if [ -f /etc/asound.conf ]; then
    sudo cp -a /etc/asound.conf "/etc/asound.conf.bak.$(date +%Y%m%d-%H%M%S)"
fi
grep -nE 'pcm\.(dsnooper|birdmic)|ipc_key 2048' /etc/asound.conf 2>/dev/null
```

If the `grep` prints anything, those names or that `ipc_key` are already in
use: pick different ones below. Also check `~/.asoundrc` of the station user,
which is read in addition to `/etc/asound.conf`.

### 2. Append the shared device

Append instead of replacing. This creates the file if it does not exist and
leaves existing sections untouched:

```bash
sudo tee -a /etc/asound.conf >/dev/null <<'EOF'

# Example: shared capture for BirdNET-Pi. Adjust slave values to your microphone.
pcm.dsnooper {
    type dsnoop
    ipc_key 2048
    slave {
        pcm "hw:CARD=Device,DEV=0"
        channels 1
        rate 48000
        format S16_LE
        period_size 1024
        buffer_size 8192
    }
}

pcm.birdmic {
    type plug
    slave.pcm "dsnooper"
}
EOF
```

Replace `hw:CARD=Device,DEV=0` with your own card. `arecord -L` lists the
names; `Device` is only what many generic USB microphones call themselves.

`channels`, `rate` and `format` must be something your microphone supports.
To see what it offers (stop the recording service first, or the card is busy):

```bash
sudo systemctl stop birdnet_recording.service
sudo -u "$STATION_USER" arecord -D hw:CARD=Device,DEV=0 --dump-hw-params -d 1 /dev/null
sudo systemctl start birdnet_recording.service
```

Look at the `CHANNELS`, `RATE` and `FORMAT` lines. The recording script asks
for 48000 Hz, 16-bit; the `plug` wrapper around `dsnooper` converts rate,
format and channel count on the fly, so a client asking for something the
slave does not provide still works instead of failing to open.

### 3. Point the config at it

In `/etc/birdnet/birdnet.conf`:

```
REC_CARD="birdmic"
```

Restart both services:

```bash
sudo systemctl restart birdnet_recording.service livestream.service
```

### 4. Check both services as the station user

Run the checks as the station user, not as root or your login user. The
services run as that user, and dsnoop's shared-memory segment is by default
only accessible to the user that created it, so a test run as someone else can
fail (or succeed) for reasons that say nothing about the services.

```bash
# the station user must be in the audio group
id -nG "$STATION_USER" | tr ' ' '\n' | grep -x audio

# the live stream's own start condition: exit status 0 means "may start"
sudo -u "$STATION_USER" /usr/local/bin/livestream.sh --check; echo "exit: $?"

# two readers at once - once through arecord (as the recording service does) ...
sudo -u "$STATION_USER" arecord -D birdmic -d 3 -f S16_LE -r 48000 /tmp/a.wav &
sudo -u "$STATION_USER" arecord -D birdmic -d 3 -f S16_LE -r 48000 /tmp/b.wav
wait
# ... and once through ffmpeg (as the live stream does)
sudo -u "$STATION_USER" ffmpeg -hide_banner -loglevel error -f alsa -i birdmic -t 3 -f null -

# both services, and why they stopped if they did
systemctl status birdnet_recording.service livestream.service --no-pager
journalctl -u birdnet_recording.service -u livestream.service -n 30 --no-pager
```

Both readers should succeed, and both services should be `active (running)`.

If a step fails, treat that as a clue, not a verdict. A failing sharing test
does not by itself prove that your driver cannot do dsnoop. Other common
causes:

- a typo in the card name, or the card numbered or named differently from
  what `arecord -L` shows for the station user
- another process holding the card: PulseAudio, a leftover `arecord`, or a
  service you forgot. `scripts/birdnet_recording.sh` starts PulseAudio itself
  when `REC_CARD` is empty, `default` or `pulse` (`ensure_pulseaudio`); with
  a named device like `birdmic` it does not, but PulseAudio may still be
  running from an earlier start or another service
- `channels`, `rate` or `format` in the example not being supported by your
  microphone
- the test run as a different user than the services, or a stale
  `ipc_key` left by an earlier attempt as another user (`ipcs -m`)
- a duplicate `pcm.` name or a conflicting definition elsewhere in the ALSA
  config
- USB power or cable problems

Work through these before concluding the card cannot be shared. Only if the
checks above are clean and the driver still refuses to create the dsnoop
device is turning off `livestream.service` the fallback.

To undo everything: restore the backup (or delete the appended block), set
`REC_CARD` back to its previous value, and restart the two services.

## Card numbers move; card names do not

`arecord -l` numbers cards in probe order, and that order can change across
reboots — a USB microphone that was `card 3` can come back as `card 1`. A
config holding `REC_CARD="plughw:3,0"` then points at nothing, and the
recording service fails on every start:

```
arecord: main:830: audio open error: No such file or directory
```

systemd restarts it, it fails again, and because the unit never settles it
shows as `activating` rather than `failed` — easy to miss for weeks.

Use the stable name instead of the number (example output; yours will differ):

```bash
sudo -u "$STATION_USER" arecord -L | grep '^plughw:CARD='
REC_CARD="plughw:CARD=Device,DEV=0"
```

The same applies inside the dsnoop slave above: `hw:CARD=Device,DEV=0`, not
`hw:3,0`. Note that a direct `plughw:` name keeps the card for the recording
service alone; the live stream stays off until `REC_CARD` is a shared device.

## Checking that sound actually arrives

A recording of the right size is not proof. Check the level:

```bash
sox ~/BirdSongs/StreamData/<a-recent-file>.wav -n stat
```

`Maximum amplitude: 0.000000` means digital silence — the device was opened but
delivered nothing. Real room noise sits around 0.001–0.01. Exact zeros often
mean something else holds the card, but they can also come from a muted or
zero-gain capture control (`alsamixer -c <card>`, then F4), a wrong channel or
format, or a microphone that is not actually powered. Treat silence as a reason
to check these one by one, not as a diagnosis on its own. For PulseAudio,
see `ensure_pulseaudio` in `scripts/birdnet_recording.sh` and the list above.

Do the same for the live stream: listen to it, and check that
`systemctl is-active livestream.service` reports `active`.

## Non-English systems

Scripts that parse `arecord -l` break when the Pi runs a non-English locale —
with `locale: de_DE.UTF-8`, the output says `Karte 3:` instead of `card 3:`, and
a `grep '^card'` finds nothing. Prefix such calls with `LC_ALL=C`.
