#!/bin/sh
# Demo server for the screenshots: an Unraid named "Tower" with sample data.
#   tools/screenshots/setup-demo.sh en|de
# Needs Docker and root. WORK (default /srv/demo) is a large tmpfs, so the page
# shows "7.6 TB free" and the big sample files cost no space (they are sparse).
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
SET=${1:-en}
WORK=${WORK:-/srv/demo}
IMAGE=${IMAGE:-ghcr.io/dropnook/dropnook:2}
case $SET in
  en) LAN=127.0.0.2; PUB=127.0.0.3; USR=127.0.0.6 ;;
  de) LAN=127.0.0.4; PUB=127.0.0.5; USR=127.0.0.7 ;;
  *) echo "usage: $0 en|de"; exit 1 ;;
esac
mkdir -p "$WORK"
mountpoint -q "$WORK" || mount -t tmpfs -o size=7800g tmpfs "$WORK"
D=$WORK/$SET
docker rm -f "demo-$SET" "demo-$SET-share" "demo-$SET-users" >/dev/null 2>&1 || true
rm -rf "$D" "$D-users"       # start clean: every run creates the same shares
mkdir -p "$D/files"
echo 'NAME="Tower"' > "$WORK/ident.cfg"
cd "$D/files"
mk() { truncate -s "$2" "$1"; touch -d "$3" "$1"; }
python3 "$HERE/sample-images.py" . "$SET"
pic() { mv "$1" "$2"; touch -d "$3" "$2"; }
if [ "$SET" = en ]; then
  mk "Vacation 2025 – Lisbon.zip" 4513218560 "2 days ago 18:42"
  mk "ubuntu-24.04.3-desktop-amd64.iso" 6203355136 "6 days ago 21:05"
  mk "Wedding – Anna & Tom.mp4" 2913478656 "3 days ago 11:20"
  mk "Tax return 2025.pdf" 2481731 "yesterday 20:14"
  mk "Brochure_final_v3.pdf" 19512340 "today 09:31"
  mk "IMG_4821.HEIC" 3248112 "today 08:02"
  pic screenshot.png "Screenshot 2026-10-06 10-14-32.png" "today 10:14"
  pic photo.jpg "Sunset at Cascais.jpg" "yesterday 19:52"
  mk "Presentation Q3.pptx" 48311902 "yesterday 15:47"
  mk "invoice-1042.pdf" 186433 "4 days ago 10:15"
  mk "Floor plan – kitchen.dwg" 7340032 "5 days ago 17:30"
  T1='Guest Wi-Fi
Network: Tower-Guest
Password: blue-lantern-58'
  T2='Sunday lasagne 🍝
https://www.example.com/recipes/classic-lasagne

Shopping: tomatoes, basil, mozzarella, parmesan, lasagne sheets, 500 g minced beef'
  T3='Parcel tracking — arrives Thursday
00340434161094042557'
  TITLE="Field 2"; BIG="Vacation 2025 – Lisbon.zip"; PW=sunny-tram-28; UP="Drone flight – 4K.mp4"
else
  mk "Ferien 2025 – Lissabon.zip" 4513218560 "2 days ago 18:42"
  mk "ubuntu-24.04.3-desktop-amd64.iso" 6203355136 "6 days ago 21:05"
  mk "Hochzeit – Anna & Tom.mp4" 2913478656 "3 days ago 11:20"
  mk "Steuererklärung 2025.pdf" 2481731 "yesterday 20:14"
  mk "Prospekt_final_v3.pdf" 19512340 "today 09:31"
  mk "IMG_4821.HEIC" 3248112 "today 08:02"
  pic screenshot.png "Bildschirmfoto 2026-10-06 10-14-32.png" "today 10:14"
  pic photo.jpg "Sonnenuntergang in Cascais.jpg" "yesterday 19:52"
  mk "Präsentation Q3.pptx" 48311902 "yesterday 15:47"
  mk "Rechnung-1042.pdf" 186433 "4 days ago 10:15"
  mk "Grundriss – Küche.dwg" 7340032 "5 days ago 17:30"
  T1='Gäste-WLAN
Netzwerk: Tower-Gast
Passwort: blaue-laterne-58'
  T2='Lasagne am Sonntag 🍝
https://www.example.com/rezepte/klassische-lasagne

Einkauf: Tomaten, Basilikum, Mozzarella, Parmesan, Lasagneblätter, 500 g Hackfleisch'
  T3='Paketverfolgung — kommt am Donnerstag
00340434161094042557'
  TITLE="Feld 2"; BIG="Ferien 2025 – Lissabon.zip"; PW=sonnige-tram-28; UP="Drohnenflug – 4K.mp4"
fi

docker rm -f "demo-$SET" "demo-$SET-share" >/dev/null 2>&1 || true
docker run -d --name "demo-$SET" -p "$LAN:80:80" -e MODE=lan -e CHUNK_MB=1 -e TLS_CERT= \
  -v "$D:/data" -v "$WORK/ident.cfg:/unraid/ident.cfg:ro" "$IMAGE" >/dev/null
until [ "$(docker inspect -f '{{.State.Health.Status}}' "demo-$SET")" = healthy ]; do sleep 1; done
docker run -d --name "demo-$SET-share" -p "$PUB:80:80" --sysctl net.ipv4.ip_unprivileged_port_start=80 \
  --user 99:100 --read-only --cap-drop ALL --tmpfs /tmp -e MODE=public -e PORT=80 -e APP_NAME=Drop \
  -v "$D/shares:/data/shares:ro" -v "$D/shares/counters:/data/shares/counters" "$IMAGE" >/dev/null
until [ "$(docker inspect -f '{{.State.Health.Status}}' "demo-$SET-share")" = healthy ]; do sleep 1; done

L=http://$LAN; P=http://$PUB; H="Host: drop.yourdomain.com"
json() { python3 -c 'import json,sys; print(json.dumps(dict(zip(sys.argv[1::2], sys.argv[2::2]))))' "$@"; }
put() { json text "$2" | curl -s --noproxy '*' -o /dev/null -X PUT -H "$H" -H 'content-type: application/json' --data-binary @- "$L/api/text/$1"; }
put 1 "$T1"; put 2 "$T2"; put 3 "$T3"
token() { python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])'; }
TT=$(python3 -c 'import json,sys; print(json.dumps({"kind":"text","field":2,"title":sys.argv[1],"text":sys.argv[2],"duration":259200}))' "$TITLE" "$T2" \
  | curl -s --noproxy '*' -X POST -H "$H" -H 'content-type: application/json' --data-binary @- "$L/api/shares" | token)
TF=$(python3 -c 'import json,sys; print(json.dumps({"kind":"file","name":sys.argv[1],"duration":604800,"password":sys.argv[2]}))' "$BIG" "$PW" \
  | curl -s --noproxy '*' -X POST -H "$H" -H 'content-type: application/json' --data-binary @- "$L/api/shares" | token)
echo "$TT $TF $PW" > "$WORK/tokens-$SET"
for i in 1 2 3 4 5 6 7; do curl -s --noproxy '*' -o /dev/null "$P/$TT"; done
curl -s --noproxy '*' -c "$WORK/cookies-$SET" -o /dev/null -X POST -d "password=$PW" "$P/$TF"
for i in 1 2 3; do
  curl -s --noproxy '*' -b "$WORK/cookies-$SET" -o /dev/null "$P/$TF"
  curl -s --noproxy '*' -b "$WORK/cookies-$SET" -o /dev/null -r 0-1023 "$P/$TF/download"
done
# An upload from "another device", stopped at 43 %.
U=$(json name "$UP" | sed 's/}$/, "size": 231735296}/' | curl -s --noproxy '*' -X POST -H "$H" -H 'content-type: application/json' --data-binary @- "$L/api/upload/init" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
head -c 1048576 /dev/zero > "$WORK/chunk"
i=0; while [ $i -lt 96 ]; do curl -s --noproxy '*' -o /dev/null -X PUT -H "$H" --data-binary "@$WORK/chunk" "$L/api/upload/$U/$i"; i=$((i+1)); done
echo "demo $SET ready on $LAN (share $PUB), tokens in $WORK/tokens-$SET"

# A second demo with users (compose.yaml: USER_<COLOUR>), on $USR: Tom's own
# area next to the shared one.
DU=$D-users
mkdir -p "$DU/files" "$DU/users/Tom/files"
cp -p "$D/files/"*.jpg "$DU/users/Tom/files/"     # the sunset — Tom's own photo
cd "$DU/users/Tom/files"
if [ "$SET" = en ]; then
  mk "CV – Tom Berger.pdf" 412337 "today 09:12"
  mk "Concert tickets – Zurich.pdf" 233144 "yesterday 21:40"
  mk "Car insurance 2026.pdf" 1288410 "3 days ago 16:05"
  cd "$DU/files"
  mk "Holiday house – booking.pdf" 845120 "today 08:30"
  mk "Family photos 2025.zip" 2147483648 "2 days ago 20:11"
  mk "Shopping list.txt" 312 "today 07:15"
  U1='Gift ideas for Anna 🎁
– the blue scarf from the market
– concert: Sophie Hunger, 14 November
– that cookbook she keeps looking at'
  U2='Gym: Mon / Wed / Fri 18:30
Bench 3×8 · Squat 3×8 · Rows 3×10'
  S1='Holiday house, 18–25 July
Check-in from 15:00, key in the box by the door
https://www.example.com/booking/4711'
else
  mk "Lebenslauf – Tom Berger.pdf" 412337 "today 09:12"
  mk "Konzerttickets – Zürich.pdf" 233144 "yesterday 21:40"
  mk "Autoversicherung 2026.pdf" 1288410 "3 days ago 16:05"
  cd "$DU/files"
  mk "Ferienhaus – Buchung.pdf" 845120 "today 08:30"
  mk "Familienfotos 2025.zip" 2147483648 "2 days ago 20:11"
  mk "Einkaufsliste.txt" 312 "today 07:15"
  U1='Geschenkideen für Anna 🎁
– der blaue Schal vom Markt
– Konzert: Sophie Hunger, 14. November
– das Kochbuch, das sie immer anschaut'
  U2='Training: Mo / Mi / Fr 18:30
Bankdrücken 3×8 · Kniebeugen 3×8 · Rudern 3×10'
  S1='Ferienhaus, 18.–25. Juli
Einchecken ab 15 Uhr, Schlüssel im Kästchen neben der Tür
https://www.example.com/buchung/4711'
fi
docker run -d --name "demo-$SET-users" -p "$USR:80:80" -e MODE=lan -e CHUNK_MB=1 -e TLS_CERT= \
  -e USER_TEAL=Anna:2468 -e USER_GOLD=Tom:1357 -e USER_BLUE=Lena:8642 -e USER_VIOLET=Max:9753 -e USER_CORAL=Mia \
  -v "$DU:/data" -v "$WORK/ident.cfg:/unraid/ident.cfg:ro" "$IMAGE" >/dev/null
until [ "$(docker inspect -f '{{.State.Health.Status}}' "demo-$SET-users")" = healthy ]; do sleep 1; done
L=http://$USR
curl -s --noproxy '*' -o /dev/null -c "$WORK/tom-$SET" -H "$H" -d 'user=gold&pin=1357' "$L/login"
uput() { json text "$3" | curl -s --noproxy '*' -o /dev/null -b "$WORK/tom-$SET" -X PUT -H "$H" -H 'content-type: application/json' --data-binary @- "$L/api/text/$2?area=$1"; }
uput own 1 "$U1"; uput own 2 "$U2"; uput shared 1 "$S1"
echo "demo $SET with users ready on $USR"
