#!/usr/bin/env bash
source /etc/birdnet/birdnet.conf
if [ "${APPRISE_WEEKLY_REPORT:-0}" = 1 ];then
	NOTIFICATION=$(cd "$EXTRACTED" && \
		/usr/bin/php -r '
			require_once "scripts/common.php";
			set_timezone();
			$_GET["ascii"] = true;
			require "weekly_report.php";
		') \
		|| exit 1
	case "$NOTIFICATION" in
		'# '*) ;;
		*) echo "Weekly report generation did not complete" >&2; exit 1;;
	esac
	NOTIFICATION=${NOTIFICATION#*#}
	firstLine=$(echo "${NOTIFICATION}" | head -1)
	NOTIFICATION=$(echo "${NOTIFICATION}" | tail -n +2)
	"$HOME/BirdNET-Pi/birdnet/bin/apprise" -vv -t "${firstLine}" \
		-b "${NOTIFICATION}" --input-format=html \
		--config="$HOME/BirdNET-Pi/apprise.txt"
fi
