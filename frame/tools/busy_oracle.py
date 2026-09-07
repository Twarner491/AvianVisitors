#!/usr/bin/env python3
"""BUSY-line oracle for the Waveshare 13.3" e-Paper HAT+ (E).

Answers one question before any driver runs: is the panel's BUSY line
electrically sound, and is the controller alive? Use this when a panel
does nothing — it distinguishes the three failure modes the panel test
cannot:

  floating      BUSY follows whichever pull bias is applied (pull-up
                reads 1, pull-down reads 0) -> the HAT-to-Pi chain is
                broken (unseated HAT, broken wire) or the panel is not
                connected.

  short to GND  BUSY reads 0 under BOTH biases, even with the panel
                unpowered -> the BUSY conductor lands on ground. On this
                panel that means a wrong adapter or flipped/shifted FFC
                in the chain, never a panel or driver fault.

  driven        BUSY reads the same under both biases with the panel
                powered -> the controller is alive. HIGH (1) = idle,
                ready for a refresh; LOW (0) = busy and stuck.

Doc-safety: no SPI bytes are sent, the reset is the vendor's 30 ms pulse
train, everything is bounded, and PWR is left LOW at exit (the vendor's
recommended storage state).

Run on the Pi (needs root for gpiochip access):
    sudo python3 busy_oracle.py [--hold SECONDS]

Optional --hold first drives PWR low for SECONDS (default 0) to force a
true panel power cut — deep sleep cannot survive it, which rules out a
stale-sleep state masquerading as dead hardware.
"""
import argparse
import time

import gpiod
from gpiod.line import Bias, Direction, Value

BUSY, PWR, RST = 24, 18, 17  # BCM numbers, per the HAT+ (E) pin map


def read_busy(chip, bias, n=5):
    """Sample BUSY n times under a pull bias; a driven line ignores it."""
    req = chip.request_lines(consumer="busy-oracle", config={
        BUSY: gpiod.LineSettings(direction=Direction.INPUT, bias=bias)})
    vals = [req.get_value(BUSY).value for _ in range(n)]
    time.sleep(0.05)
    req.release()
    return vals


def vendor_power_on(ctl):
    """The HAT's documented power-on: PWR pulse 1-0-1, then a 30 ms reset."""
    ctl.set_value(PWR, Value.ACTIVE); time.sleep(0.03)
    ctl.set_value(PWR, Value.INACTIVE); time.sleep(0.03)
    ctl.set_value(PWR, Value.ACTIVE); time.sleep(0.05)
    for v in (Value.ACTIVE, Value.INACTIVE, Value.ACTIVE, Value.INACTIVE, Value.ACTIVE):
        ctl.set_value(RST, v)
        time.sleep(0.03)


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--hold", type=float, default=0.0, metavar="SECONDS",
                    help="hold PWR low first for a true power cut (default: skip)")
    args = ap.parse_args()

    chip = gpiod.Chip("/dev/gpiochip0")
    ctl = chip.request_lines(consumer="busy-oracle-ctl", config={
        PWR: gpiod.LineSettings(direction=Direction.OUTPUT, output_value=Value.INACTIVE),
        RST: gpiod.LineSettings(direction=Direction.OUTPUT, output_value=Value.ACTIVE),
    })

    if args.hold > 0:
        print(f"PWR held LOW for {args.hold:.0f}s (true panel power cut)...", flush=True)
        time.sleep(args.hold)
        print("powering on (vendor sequence)...", flush=True)
        vendor_power_on(ctl)
        time.sleep(0.3)

    u_down = read_busy(chip, Bias.PULL_DOWN)
    u_up = read_busy(chip, Bias.PULL_UP)
    print(f"BUSY unpowered: pull-down={u_down} pull-up={u_up}", flush=True)

    vendor_power_on(ctl)
    time.sleep(0.3)
    p_down = read_busy(chip, Bias.PULL_DOWN)
    p_up = read_busy(chip, Bias.PULL_UP)
    print(f"BUSY powered:   pull-down={p_down} pull-up={p_up}", flush=True)

    if u_down[0] == 0 and u_up[0] == 0:
        verdict = ("BUSY SHORTED TO GND (reads 0 even unpowered, under both pulls) — "
                   "wrong adapter / flipped or shifted FFC in the chain; not a panel or driver fault")
    elif p_down[0] == 0 and p_up[0] == 1:
        verdict = ("BUSY FLOATING even when powered — the HAT-to-Pi chain is broken "
                   "(unseated HAT / broken wire) or the panel is not connected")
    elif p_down[0] == 1:
        verdict = "PANEL ALIVE — controller drives BUSY HIGH (idle); ready for a refresh"
    else:
        verdict = ("PANEL ALIVE but drives BUSY LOW (busy) at power-up and never releases — "
                   "power-up sequence not completing (supply/HV or panel damage)")
    print("VERDICT:", verdict, flush=True)

    ctl.set_value(PWR, Value.INACTIVE)  # leave the panel unpowered (storage state)
    ctl.release()
    print("PWR left OFF. DONE", flush=True)


if __name__ == "__main__":
    main()
