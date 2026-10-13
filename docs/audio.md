# Audio: sharing one microphone, and picking the right device name

Two things about the capture device bite almost everyone who runs a USB
microphone on a headless Pi. Neither produces a useful error message.

## Running the live stream and the analysis at the same time

`birdnet_recording.sh` and `livestream.sh` both open `$REC_CARD`:

```bash
arecord -D "${REC_CARD}" …                    # birdnet_recording.sh
ffmpeg -f alsa -i ${REC_CARD} …               # livestream.sh
```

Most USB audio devices allow exactly one capture client. Whichever service
starts first wins; the other dies with:

```
audio open error: Device or resource busy
```

The usual advice is to disable the live stream. You do not have to. ALSA ships
`dsnoop`, which splits one capture stream between several readers.

Create `/etc/asound.conf`:

```
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
```

Replace `hw:CARD=Device,DEV=0` with your own card — `arecord -L` lists them.
Then point the config at the new PCM instead of the raw device:

```
REC_CARD="birdmic"
```

Restart both services. To confirm the sharing works, run two readers at once:

```bash
arecord -D birdmic -d 3 -f S16_LE -r 48000 /tmp/a.wav &
arecord -D birdmic -d 3 -f S16_LE -r 48000 /tmp/b.wav
```

Both should succeed. If your driver refuses to create the dsnoop device, the
stream and the analysis genuinely cannot share the card, and disabling
`livestream.service` remains the only option.

The `plug` wrapper around `dsnooper` matters: it converts sample rate and
format on the fly, so a client asking for something the slave does not provide
still works instead of failing to open.

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

Use the stable name instead of the number:

```bash
arecord -L | grep '^plughw:CARD='
REC_CARD="plughw:CARD=Device,DEV=0"
```

## Checking that sound actually arrives

A recording of the right size is not proof. Check the level:

```bash
sox ~/BirdSongs/StreamData/<a-recent-file>.wav -n stat
```

`Maximum amplitude: 0.000000` means digital silence — the device was opened but
delivered nothing. Real room noise sits around 0.001–0.01. Exact zeros usually
mean something else holds the card; see the PulseAudio note in
`scripts/birdnet_recording.sh`.

## Non-English systems

Scripts that parse `arecord -l` break when the Pi runs a non-English locale —
with `locale: de_DE.UTF-8`, the output says `Karte 3:` instead of `card 3:`, and
a `grep '^card'` finds nothing. Prefix such calls with `LC_ALL=C`.
