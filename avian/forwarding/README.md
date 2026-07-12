# Forwarding

Default install hosts the collage at `http://birdnet.local/` on your LAN, no auth. The recipes below are independent. Pick what you need.

---

## 1. Cloudflare Tunnel

Public HTTPS URL, no port forwarding. Needs a free Cloudflare account.

```bash
sudo apt install -y lsb-release
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg \
  | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null

# Debian 13 (trixie) currently does not publish a trixie package repo, so use bookworm.
echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared bookworm main" \
  | sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt update && sudo apt install -y cloudflared

cloudflared tunnel login
cloudflared tunnel create birds
cloudflared tunnel route dns birds yourdomain.com

sudo cp ~/AvianVisitors/avian/forwarding/cloudflared.yml /etc/cloudflared/config.yml
# Replace TUNNEL_UUID in /etc/cloudflared/config.yml with the UUID returned by `cloudflared tunnel create birds`
sudo cloudflared service install
sudo systemctl restart cloudflared
```

Add a password gate via Cloudflare Access (free for up to 50 users) or via Caddy basic_auth ([`caddy-auth.caddy`](caddy-auth.caddy)).

---

## 2. Home Assistant sensor

Add to `configuration.yaml`:

```yaml
rest:
  - resource: http://birdnet.local/avian/api/birdnet-api.php?action=recent&hours=1
    scan_interval: 60
    sensor:
      - name: "Latest Bird"
        value_template: "{{ value_json.species[0].com if value_json.species else 'none' }}"
        json_attributes_path: "$.species[0]"
        json_attributes:
          - sci
          - n
          - last_seen
          - best_conf
```

---

## 3. MQTT bridge

```bash
sudo pip3 install paho-mqtt --break-system-packages
cp ~/BirdNET-Pi/avian/forwarding/mqtt-bridge.py ~/avian-mqtt.py
# Edit ~/avian-mqtt.py: broker host, topic prefix, credentials
sudo cp ~/BirdNET-Pi/avian/forwarding/avian-mqtt.service /etc/systemd/system/
# Edit /etc/systemd/system/avian-mqtt.service: set User= to your username
sudo systemctl daemon-reload
sudo systemctl enable --now avian-mqtt
```

Polls `birdnet-api.php?action=recent&hours=1` every 60 seconds. Publishes new species under `birdnet/<slug>` as JSON. Dedup is in-memory; restarts re-emit recent detections.
