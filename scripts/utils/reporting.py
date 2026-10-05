import glob
import json
import logging
import os
import re
import sqlite3
import subprocess
import tempfile
import io
import soundfile
from time import sleep

import requests
from PIL import Image, ImageDraw, ImageFont

from .helpers import get_settings, get_font, DB_PATH
from .classes import Detection, ParseFileName
from .notifications import sendAppriseNotifications

log = logging.getLogger(__name__)

_BIRDWEATHER_API = 'https://app.birdweather.com/api/v1/stations'
_BIRDWEATHER_TOKEN = re.compile(r'\A[A-Za-z0-9._~-]{1,160}\Z')


def birdweather_config(conf):
    """Return the effective sharing policy without exposing the station token.

    BirdNET-Pi historically treated a non-empty BIRDWEATHER_ID as both the
    enable switch and permission to upload each source recording. Preserve
    that behavior only when both new policy keys are absent. Once either key
    exists, an absent audio key fails closed to detections-only sharing.
    """
    token = str(conf.get('BIRDWEATHER_ID', '') or '').strip()
    enabled_explicit = 'BIRDWEATHER_ENABLED' in conf
    audio_explicit = 'BIRDWEATHER_UPLOAD_AUDIO' in conf

    enabled_raw = str(conf.get('BIRDWEATHER_ENABLED', '') or '').strip()
    audio_raw = str(conf.get('BIRDWEATHER_UPLOAD_AUDIO', '') or '').strip()
    enabled = enabled_raw == '1' if enabled_explicit else bool(token)
    upload_audio = audio_raw == '1' if audio_explicit else (
        bool(token) and not enabled_explicit
    )

    valid_token = token not in {'.', '..'} and bool(
        _BIRDWEATHER_TOKEN.fullmatch(token)
    )
    return {
        'enabled': enabled and valid_token,
        'upload_audio': upload_audio,
        'token': token if valid_token else '',
        'token_configured': bool(token),
        'token_valid': valid_token,
        'enabled_implicit': not enabled_explicit,
        'upload_audio_implicit': not audio_explicit,
    }


def extract(in_file, out_file, start, stop):
    result = subprocess.run(['sox', '-V1', f'{in_file}', f'{out_file}', 'trim', f'={start}', f'={stop}'],
                            check=True, capture_output=True)
    ret = result.stdout.decode('utf-8')
    err = result.stderr.decode('utf-8')
    if err:
        raise RuntimeError(f'{ret}:\n {err}')
    return ret


def extract_safe(in_file, out_file, start, stop):
    conf = get_settings()
    # This section sets the SPACER that will be used to pad the audio clip with
    # context. If EXTRACTION_LENGTH is 10, for instance, 3 seconds are removed
    # from that value and divided by 2, so that the 3 seconds of the call are
    # within 3.5 seconds of audio context before and after.
    try:
        ex_len = conf.getint('EXTRACTION_LENGTH')
    except ValueError:
        ex_len = 6
    spacer = (ex_len - 3) / 2
    safe_start = max(0, start - spacer)
    safe_stop = min(conf.getint('RECORDING_LENGTH'), stop + spacer)

    extract(in_file, out_file, safe_start, safe_stop)


def spectrogram(in_file, title, comment, raw=0):
    fd, tmp_file = tempfile.mkstemp(suffix='.png')
    os.close(fd)
    args = ['sox', '-V1', f'{in_file}', '-n', 'remix', '1', 'rate', '24k', 'spectrogram',
            '-t', '', '-c', '', '-o', tmp_file]
    args += ['-r'] if int(raw) else []

    result = subprocess.run(args, check=True, capture_output=True)
    ret = result.stdout.decode('utf-8')
    err = result.stderr.decode('utf-8')
    if err:
        raise RuntimeError(f'{ret}:\n {err}')
    img = Image.open(tmp_file)
    height = img.size[1]
    width = img.size[0]
    draw = ImageDraw.Draw(img)
    title_font = ImageFont.truetype(get_font()['path'], 13)
    _, _, w, _ = draw.textbbox((0, 0), title, font=title_font)
    draw.text(((width-w)/2, 6), title, fill="white", font=title_font)

    comment_font = ImageFont.truetype(get_font()['path'], 11)
    _, _, _, h = draw.textbbox((0, 0), comment, font=comment_font)
    draw.text((1, height - (h + 1)), comment, fill="white", font=comment_font)
    img.save(f'{in_file}.png')
    os.remove(tmp_file)


def extract_detection(file: ParseFileName, detection: Detection):
    conf = get_settings()
    new_file_name = f'{detection.common_name_safe}-{detection.confidence_pct}-{detection.date}-birdnet-{file.RTSP_id}{detection.time}.{conf["AUDIOFMT"]}'
    new_dir = os.path.join(conf['EXTRACTED'], 'By_Date', f'{detection.date}', f'{detection.common_name_safe}')
    new_file = os.path.join(new_dir, new_file_name)
    if os.path.isfile(new_file):
        log.warning('Extraction exists. Moving on: %s', new_file)
    else:
        os.makedirs(new_dir, exist_ok=True)
        extract_safe(file.file_name, new_file, detection.start, detection.stop)
        spectrogram(new_file, detection.common_name, new_file.replace(os.path.expanduser('~/'), ''), conf['RAW_SPECTROGRAM'])
    return new_file


def write_to_db(file: ParseFileName, detection: Detection):
    conf = get_settings()
    # Connect to SQLite Database
    for attempt_number in range(3):
        try:
            con = sqlite3.connect(DB_PATH)
            cur = con.cursor()
            cur.execute("INSERT INTO detections VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                        (detection.date, detection.time, detection.scientific_name, detection.common_name, detection.confidence,
                         conf['LATITUDE'], conf['LONGITUDE'], conf['CONFIDENCE'], str(detection.week), conf['SENSITIVITY'],
                         conf['OVERLAP'], os.path.basename(detection.file_name_extr)))
            # (Date, Time, Sci_Name, Com_Name, str(score),
            # Lat, Lon, Cutoff, Week, Sens,
            # Overlap, File_Name))

            con.commit()
            con.close()
            break
        except BaseException as e:
            log.warning("Database busy: %s", e)
            sleep(2)


def summary(file: ParseFileName, detection: Detection):
    # Date;Time;Sci_Name;Com_Name;Confidence;Lat;Lon;Cutoff;Week;Sens;Overlap
    # 2023-03-03;12:48:01;Phleocryptes melanops;Wren-like Rushbird;0.76950216;-1;-1;0.7;9;1.25;0.0
    conf = get_settings()
    s = (f'{detection.date};{detection.time};{detection.scientific_name};{detection.common_name};'
         f'{detection.confidence};'
         f'{conf["LATITUDE"]};{conf["LONGITUDE"]};{conf["CONFIDENCE"]};{detection.week};{conf["SENSITIVITY"]};'
         f'{conf["OVERLAP"]}')
    return s


def write_to_file(file: ParseFileName, detection: Detection):
    with open(os.path.expanduser('~/BirdNET-Pi/BirdDB.txt'), 'a') as rfile:
        rfile.write(f'{summary(file, detection)}\n')


def update_json_file(file: ParseFileName, detections: [Detection]):
    if file.RTSP_id is None:
        mask = f'{os.path.dirname(file.file_name)}/*.json'
    else:
        mask = f'{os.path.dirname(file.file_name)}/*{file.RTSP_id}*.json'
    for f in glob.glob(mask):
        log.debug(f'deleting {f}')
        os.remove(f)
    write_to_json_file(file, detections)


def write_to_json_file(file: ParseFileName, detections: [Detection]):
    conf = get_settings()
    json_file = f'{file.file_name}.json'
    log.debug(f'WRITING RESULTS TO {json_file}')
    dets = {'file_name': os.path.basename(json_file), 'timestamp': file.iso8601, 'delay': conf['RECORDING_LENGTH'],
            'detections': [{"start": det.start, "common_name": det.common_name, "confidence": det.confidence} for det in
                           detections]}
    with open(json_file, 'w') as rfile:
        rfile.write(json.dumps(dets))
    log.debug(f'DONE! WROTE {len(detections)} RESULTS.')


def apprise(file: ParseFileName, detections: [Detection]):
    species_apprised_this_run = []
    conf = get_settings()

    for detection in detections:
        # Apprise of detection if not already alerted this run.
        if detection.species not in species_apprised_this_run:
            try:
                sendAppriseNotifications(detection.scientific_name, detection.common_name, str(detection.confidence), str(detection.confidence_pct),
                                         os.path.basename(detection.file_name_extr), detection.date, detection.time, str(detection.week),
                                         conf['LATITUDE'], conf['LONGITUDE'], conf['CONFIDENCE'], conf['SENSITIVITY'], conf['OVERLAP'])

            except BaseException as e:
                log.exception('Error during Apprise:', exc_info=e)

            species_apprised_this_run.append(detection.species)


def bird_weather(file: ParseFileName, detections: [Detection]):
    conf = get_settings()
    policy = birdweather_config(conf)
    result = {
        'enabled': policy['enabled'],
        'soundscape_uploaded': False,
        'detections_posted': 0,
    }
    if not policy['enabled'] or not detections:
        if policy['token_configured'] and not policy['token_valid']:
            log.error('BirdWeather sharing is disabled because the station token is invalid')
        return result

    session = requests.Session()
    # A station token is carried in the URL path. Do not send that URL through
    # ambient proxy or netrc configuration inherited by the service manager.
    session.trust_env = False
    session.headers.update({
        'Accept': 'application/json',
        'User-Agent': 'BirdNET-Pi AvianVisitors',
    })
    station_url = f'{_BIRDWEATHER_API}/{policy["token"]}'
    soundscape_id = None

    try:
        if policy['upload_audio']:
            try:
                data, samplerate = soundfile.read(file.file_name)
                buf = io.BytesIO()
                soundfile.write(buf, data, samplerate, format='FLAC')
                flac_data = buf.getvalue()
            except Exception:
                log.error('BirdWeather audio conversion failed')
                return result

            try:
                response = session.post(
                    f'{station_url}/soundscapes',
                    params={'timestamp': file.iso8601},
                    data=flac_data,
                    timeout=(5, 15),
                    allow_redirects=False,
                    headers={'Content-Type': 'audio/flac'},
                )
                log.info('BirdWeather soundscape response status - %d', response.status_code)
                if not 200 <= response.status_code < 300:
                    log.error('BirdWeather soundscape upload was rejected')
                    return result
                response_data = response.json()
            except (requests.RequestException, ValueError):
                # Request exceptions may contain the complete token-bearing
                # URL. Keep the log intentionally generic.
                log.error('BirdWeather soundscape upload failed')
                return result

            soundscape = response_data.get('soundscape') if isinstance(response_data, dict) else None
            soundscape_id = soundscape.get('id') if isinstance(soundscape, dict) else None
            success = response_data.get('success') if isinstance(response_data, dict) else False
            if success is not True or not isinstance(soundscape_id, (int, str)) \
                    or str(soundscape_id) == '':
                log.error('BirdWeather returned an invalid soundscape response')
                return result
            result['soundscape_uploaded'] = True

        for detection in detections:
            payload = {
                'timestamp': detection.iso8601,
                'lat': conf['LATITUDE'],
                'lon': conf['LONGITUDE'],
                'commonName': detection.common_name,
                'scientificName': detection.scientific_name,
                'algorithm': '2p4' if conf['MODEL'] == 'BirdNET_GLOBAL_6K_V2.4_Model_FP16' else 'alpha',
                'confidence': detection.confidence,
            }
            if soundscape_id is not None:
                payload.update({
                    'soundscapeId': soundscape_id,
                    'soundscapeStartTime': detection.start,
                    'soundscapeEndTime': detection.stop,
                })
            try:
                response = session.post(
                    f'{station_url}/detections',
                    json=payload,
                    timeout=(5, 10),
                    allow_redirects=False,
                )
                log.info('BirdWeather detection response status - %d', response.status_code)
                if 200 <= response.status_code < 300:
                    result['detections_posted'] += 1
                else:
                    log.error('BirdWeather detection upload was rejected')
            except requests.RequestException:
                log.error('BirdWeather detection upload failed')
    finally:
        session.close()
    return result


def heartbeat():
    conf = get_settings()
    if conf['HEARTBEAT_URL']:
        try:
            result = requests.get(url=conf['HEARTBEAT_URL'], timeout=10)
            log.info('Heartbeat: %s', result.text)
        except BaseException as e:
            log.error('Error during heartbeat: %s', e)
