# syntax=docker/dockerfile:1
# From the repository root:
# docker build -f tests/publication-runtime.Dockerfile -t avian-publication-test .
# docker run --rm --network none -v "$PWD:/source:ro" -w /source \
#   avian-publication-test -q -p no:cacheprovider tests/test_image_publication.py
FROM python:3.11-slim-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends \
      php-cli php-gd php-sqlite3 sqlite3 passwd \
    && rm -rf /var/lib/apt/lists/* \
    && pip install --no-cache-dir Pillow==11.3.0 numpy pytest

# Fixed production paths are provisioned only inside this disposable image.
RUN groupadd --system caddy \
    && install -d -o root -g root -m 0755 /var/lib/avian-visitors
COPY <<EOF /var/lib/avian-visitors/admin-auth.state
v1	0	0	-
EOF
COPY <<'EOF' /usr/local/bin/rembg-cli
#!/bin/sh
set -eu
[ "$#" -eq 6 ]
[ "$1" = i ]
[ "$2" = -m ]
[ "$3" = u2netp ]
[ "$4" = -ppm ]
cp "$OUTPUT_PNG" "$6"
printf '%s' "$6" > "$OUTPUT_LOCATION"
EOF
RUN chown root:caddy /var/lib/avian-visitors/admin-auth.state \
    && chmod 0640 /var/lib/avian-visitors/admin-auth.state \
    && chmod 0755 /usr/local/bin/rembg-cli
ENV AVIAN_PUBLICATION_CONTAINER=1
ENTRYPOINT ["python", "-m", "pytest"]
