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

import numpy as np
import librosa


def adaptive_quiet_frame_denoise(
    audio: np.ndarray,
    sample_rate: int,
    *,
    n_fft: int = 2048,
    hop_length: int = 512,
    quiet_fraction: float = 0.20,
    strength: float = 0.35,
    minimum_gain: float = 0.55,
    noise_percentile: float = 50.0,
    temporal_smoothing: float = 0.80,
) -> np.ndarray:
    """
    Reduce stationary noise using the quietest frames in the current recording.

    Parameters
    ----------
    audio:
        Mono floating-point audio, normally in the range [-1, 1].

    sample_rate:
        Audio sample rate.

    quiet_fraction:
        Fraction of STFT frames used to estimate noise.
        0.20 means the quietest 20% of frames.

    strength:
        Amount of estimated noise power removed.
        0.0 does nothing; 1.0 applies full subtraction.

    minimum_gain:
        Lowest allowed amplitude gain.
        0.55 limits attenuation to about -5.2 dB.

    noise_percentile:
        Percentile used across selected quiet frames.
        50 means median. Lower values are more conservative.

    temporal_smoothing:
        Smooths the gain between adjacent frames.
        Higher values produce fewer musical-noise artifacts.
    """
    if audio.ndim != 1:
        raise ValueError("Expected mono audio")

    if len(audio) < n_fft:
        return audio.astype(np.float32, copy=True)

    if not 0.0 < quiet_fraction <= 1.0:
        raise ValueError("quiet_fraction must be between 0 and 1")

    if not 0.0 <= strength <= 1.0:
        raise ValueError("strength must be between 0 and 1")

    if not 0.0 < minimum_gain <= 1.0:
        raise ValueError("minimum_gain must be between 0 and 1")

    spectrum = librosa.stft(
        audio,
        n_fft=n_fft,
        hop_length=hop_length,
        window="hann",
        center=True,
    )

    power = np.abs(spectrum) ** 2

    # Total spectral power of each time frame.
    frame_power = np.mean(power, axis=0)

    number_of_frames = power.shape[1]
    quiet_count = max(3, int(np.ceil(number_of_frames * quiet_fraction)))
    quiet_count = min(quiet_count, number_of_frames)

    # Indices of the quietest frames, independent of their time positions.
    quiet_indices = np.argpartition(
        frame_power,
        quiet_count - 1,
    )[:quiet_count]

    quiet_power = power[:, quiet_indices]

    # One adaptive noise estimate per frequency bin.
    noise_power = np.percentile(
        quiet_power,
        noise_percentile,
        axis=1,
        keepdims=True,
    )

    epsilon = np.finfo(np.float32).eps

    # Wiener-like soft attenuation:
    # strong signals receive little attenuation;
    # bins close to the noise profile receive more attenuation.
    raw_gain_power = 1.0 - (
        strength * noise_power / np.maximum(power, epsilon)
    )

    minimum_power_gain = minimum_gain**2
    gain_power = np.clip(
        raw_gain_power,
        minimum_power_gain,
        1.0,
    )

    gain = np.sqrt(gain_power)

    # Smooth gain over time to reduce metallic or "musical noise" artifacts.
    if gain.shape[1] > 1 and temporal_smoothing > 0.0:
        smoothed_gain = gain.copy()

        for frame_index in range(1, gain.shape[1]):
            smoothed_gain[:, frame_index] = (
                temporal_smoothing * smoothed_gain[:, frame_index - 1]
                + (1.0 - temporal_smoothing) * gain[:, frame_index]
            )

        gain = smoothed_gain

    cleaned_spectrum = spectrum * gain

    cleaned = librosa.istft(
        cleaned_spectrum,
        hop_length=hop_length,
        window="hann",
        length=len(audio),
    )

    return cleaned.astype(np.float32)