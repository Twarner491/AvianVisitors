import numpy as np
from scipy.signal import butter, iirnotch, sosfiltfilt, filtfilt


def highpass(
    audio: np.ndarray,
    sample_rate: int,
    cutoff_hz: float = 180.0,
    order: int = 4,
) -> np.ndarray:
    """Apply a zero-phase Butterworth high-pass filter."""
    if audio.ndim != 1:
        raise ValueError("Expected mono audio")

    nyquist = sample_rate / 2.0
    if not 0.0 < cutoff_hz < nyquist:
        raise ValueError(f"Invalid cutoff: {cutoff_hz}")

    sos = butter(
        order,
        cutoff_hz / nyquist,
        btype="highpass",
        output="sos",
    )
    return sosfiltfilt(sos, audio).astype(np.float32)


def notch(
    audio: np.ndarray,
    sample_rate: int,
    frequency_hz: float,
    quality: float = 40.0,
) -> np.ndarray:
    """Apply a narrow zero-phase notch filter."""
    nyquist = sample_rate / 2.0
    if not 0.0 < frequency_hz < nyquist:
        return audio

    b, a = iirnotch(
        frequency_hz / nyquist,
        quality,
    )
    return filtfilt(b, a, audio).astype(np.float32)


def filter_for_birdnet(
    audio: np.ndarray,
    sample_rate: int,
    *,
    highpass_hz: float = 180.0,
    notch_frequencies: tuple[float, ...] = (),
) -> np.ndarray:
    """Conservative preprocessing intended for BirdNET inference."""
    filtered = highpass(audio, sample_rate, highpass_hz)

    for frequency in notch_frequencies:
        filtered = notch(filtered, sample_rate, frequency)

    # Prevent rare numerical overshoots outside librosa's normal range.
    peak = float(np.max(np.abs(filtered)))
    if peak > 1.0:
        filtered /= peak

    return filtered.astype(np.float32)

import librosa
import numpy as np


def soft_stationary_denoise(
    audio: np.ndarray,
    sample_rate: int,
    *,
    n_fft: int = 2048,
    hop_length: int = 512,
    floor_percentile: float = 20.0,
    strength: float = 0.65,
    minimum_gain: float = 0.30,
) -> np.ndarray:
    """
    Attenuate stationary spectral energy without fully removing it.

    strength=0 does nothing.
    strength=1 applies the full estimated reduction.
    minimum_gain prevents any bin from being completely erased.
    """
    spectrum = librosa.stft(
        audio,
        n_fft=n_fft,
        hop_length=hop_length,
        window="hann",
    )

    magnitude = np.abs(spectrum)
    phase = np.exp(1j * np.angle(spectrum))

    noise_floor = np.percentile(
        magnitude,
        floor_percentile,
        axis=1,
        keepdims=True,
    )

    target = np.maximum(
        magnitude - strength * noise_floor,
        minimum_gain * magnitude,
    )

    cleaned = librosa.istft(
        target * phase,
        hop_length=hop_length,
        length=len(audio),
    )

    return cleaned.astype(np.float32)