import datetime
import os
import re

from tzlocal import get_localzone


def birdnet_week(d):
    """Week number in BirdNET's convention: 48 weeks, 4 per month.

    The range model was trained on this partitioning, so it is what the
    meta-model's week input has to be. ISO weeks (1-53) are a different
    partitioning entirely: they drift against this one by up to five
    weeks late in the year, and 49-53 fall outside the trained domain
    altogether. BirdNetV1 catches out-of-domain values and drops the
    seasonal signal (models.py _convert_metadata), but the V2.4 range
    model feeds the number straight into the tensor, where a wrong week
    silently changes which species are admitted at all.
    """
    return (d.month - 1) * 4 + min(4, (d.day - 1) // 7 + 1)


class Detection:
    def __init__(self, file_date, start_time, stop_time, scientific_name, common_name, confidence):
        self.start = float(start_time)
        self.stop = float(stop_time)
        self.datetime = file_date + datetime.timedelta(seconds=self.start)
        self.date = self.datetime.strftime("%Y-%m-%d")
        self.time = self.datetime.strftime("%H:%M:%S")
        self.iso8601 = self.datetime.astimezone(get_localzone()).isoformat()
        self.week = self.datetime.isocalendar()[1]
        self.confidence = round(float(confidence), 4)
        self.confidence_pct = round(self.confidence * 100)
        self.species = scientific_name
        self.scientific_name = scientific_name
        self.common_name = common_name
        self.common_name_safe = self.common_name.replace("'", "").replace(" ", "_")
        self.file_name_extr = None

    def __str__(self):
        return f'Detection({self.species}, {self.common_name}, {self.confidence}, {self.iso8601})'


class ParseFileName:
    def __init__(self, file_name):
        self.file_name = file_name
        name = os.path.splitext(os.path.basename(file_name))[0]
        date_created = re.search('^[0-9]+-[0-9]+-[0-9]+', name).group()
        time_created = re.search('[0-9]+:[0-9]+:[0-9]+$', name).group()
        self.file_date = datetime.datetime.strptime(f'{date_created}T{time_created}', "%Y-%m-%dT%H:%M:%S")
        self.root = name

        ident_match = re.search("RTSP_[0-9]+-", file_name)
        self.RTSP_id = ident_match.group() if ident_match is not None else ""

    @property
    def iso8601(self):
        current_iso8601 = self.file_date.astimezone(get_localzone()).isoformat()
        return current_iso8601

    @property
    def week(self):
        # Feeds the range model only (analysis.py), so it is BirdNET's
        # week. Detection.week stays ISO because that one is written to
        # the Week column and BirdDB.txt, where the meaning is fixed.
        return birdnet_week(self.file_date)
