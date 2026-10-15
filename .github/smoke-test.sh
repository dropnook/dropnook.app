#!/usr/bin/env bash
# Starts both containers the way compose.yaml does and checks that Drop works
# and stays locked down. Run by .github/workflows/image.yml before anything is
# published; locally:  .github/smoke-test.sh <image>
set -euo pipefail

IMAGE=${1:?usage: $0 <image>}
LAN=127.0.0.1:18080
PUB=127.0.0.1:18081
HOST=drop.ci.test                      # opened by name, as in a real setup
WORK=$(mktemp -d)
DATA=$WORK/data
mkdir -p "$DATA"
failed=0

cleanup() {
  if [ "$failed" != 0 ]; then
    echo "--- log drop";       docker logs ci-drop 2>&1 | tail -40 || true
    echo "--- log drop-share"; docker logs ci-drop-share 2>&1 | tail -40 || true
  fi
  docker rm -f ci-drop ci-drop-share ci-drop-pin ci-drop-users ci-cw ci-cw-drop ci-cw-share >/dev/null 2>&1 || true
  docker network rm ci-cw >/dev/null 2>&1 || true
  # The containers own the files (99:100); remove them from inside.
  docker run --rm -v "$WORK:/w" --entrypoint rm "$IMAGE" -rf /w/data /w/pin /w/users /w/cw >/dev/null 2>&1 || true
  rm -rf "$WORK" 2>/dev/null || true
}
trap cleanup EXIT
trap 'failed=1; echo "FAIL  unexpected error in line $LINENO"' ERR

ok()   { echo "ok    $1"; }
fail() { echo "FAIL  $1"; failed=1; exit 1; }
check() { local name=$1; shift; if "$@"; then ok "$name"; else fail "$name"; fi; }
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

wait_healthy() {
  for _ in $(seq 1 60); do
    case $(docker inspect -f '{{.State.Health.Status}}' "$1" 2>/dev/null) in
      healthy) ok "$1 is healthy"; return ;;
      unhealthy) fail "$1 is unhealthy" ;;
    esac
    [ "$(docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null)" = true ] || fail "$1 stopped"
    sleep 2
  done
  fail "$1 did not get healthy"
}

# ---------------------------------------------------------------- compose.yaml
# A pure template: every value comes from the .env next to it — special
# characters intact, presets for whatever is left out. Without the two
# addresses it refuses to start rather than guess.
COMPOSE="$(cd "$(dirname "$0")/.." && pwd)/compose-projects-drop/compose.yaml"
printf "%s\n" 'DROP_IP=192.168.1.20' 'SHARE_IP=192.168.1.21' > "$WORK/min.env"
cp "$WORK/min.env" "$WORK/ci.env"
printf "%s\n" "PIN='a\$b#c 9'" 'USER_GOLD=Zoë Müller:1357' 'TLS_CERT=' 'DATA_DIR=/mnt/disk1/drop' >> "$WORK/ci.env"
conf() { docker compose -f "$COMPOSE" "$@" config --format json | python3 -c '
import json, sys
s = json.load(sys.stdin)["services"]
d, p = s["drop"], s["drop-share"]
e = d["environment"]
mount = lambda svc, t: next(v["source"] for v in svc["volumes"] if v["target"] == t)
print("|".join([e["PIN"], e["USER_GOLD"], e["USER_TEAL"], e["TLS_CERT"], e["TLS_KEY"], e["TZ"],
                d["networks"]["br0"]["ipv4_address"], p["networks"]["br0"]["ipv4_address"],
                mount(d, "/data"), mount(p, "/data/shares")]))'; }
# Compose checks the services in no fixed order: it names DROP_IP or SHARE_IP.
refused() { ! out=$(docker compose -f "$COMPOSE" --env-file /dev/null config 2>&1) \
  && grep -qE "(DROP|SHARE)_IP is missing in the .env" <<<"$out"; }
# (config prints a $ as $$ — the container gets a single one)
check "compose.yaml: values from .env" \
  test "$(conf --env-file "$WORK/ci.env")" = 'a$$b#c 9|Zoë Müller:1357|||||192.168.1.20|192.168.1.21|/mnt/disk1/drop|/mnt/disk1/drop/shares'
check "compose.yaml: presets for the rest" \
  test "$(conf --env-file "$WORK/min.env")" = '|||auto|||192.168.1.20|192.168.1.21|/mnt/user/drop|/mnt/user/drop/shares'
check "compose.yaml: .env.example as it is, with two addresses" \
  test "$(conf --env-file "${COMPOSE%/*}/.env.example" --env-file "$WORK/min.env")" = '|||auto|||192.168.1.20|192.168.1.21|/mnt/user/drop|/mnt/user/drop/shares'
check "compose.yaml: without .env it refuses, naming the address" refused
images() { docker compose -f "$COMPOSE" "$@" config --format json | python3 -c '
import json, sys; print(" ".join(sorted({v["image"] for v in json.load(sys.stdin)["services"].values()})))'; }
check "compose.yaml: image version 2 by default" test "$(images --env-file "$WORK/min.env")" = ghcr.io/dropnook/dropnook:2
printf 'DROPNOOK_VERSION=2.2.1\n' | cat "$WORK/min.env" - > "$WORK/pinned.env"
check "compose.yaml: image version from .env"   test "$(images --env-file "$WORK/pinned.env")" = ghcr.io/dropnook/dropnook:2.2.1

# ---------------------------------------------------------------- drop (LAN)
docker run -d --name ci-drop -p "$LAN:80" \
  --cap-drop ALL --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER --cap-add NET_BIND_SERVICE \
  --security-opt no-new-privileges:true --memory 2g --pids-limit 200 \
  -e MODE=lan -e TLS_CERT= -e SERVER_NAME=CI -e CHUNK_MB=1 -e "WEBUI=http://$HOST/" \
  -v "$DATA:/data" "$IMAGE" >/dev/null
wait_healthy ci-drop

check "page loads"              test "$(code -H "Host: $HOST" "http://$LAN/")" = 200
check "state answers"           test "$(code -H "Host: $HOST" "http://$LAN/api/state")" = 200
check "proxied request refused" test "$(code -H "Host: $HOST" -H 'X-Forwarded-For: 203.0.113.9' "http://$LAN/api/state")" = 404
check "no changes from other sites" test "$(code -H "Host: $HOST" -H 'Sec-Fetch-Site: same-site' -H 'Content-Type: text/plain' \
  -d '{"text":"spam"}' "http://$LAN/api/text")" = 403
check "data folders created"    test -d "$DATA/files" -a -d "$DATA/texts" -a -d "$DATA/shares/counters"

# Only names that are Drop's — against DNS rebinding: another site pointing its
# name at Drop's address would otherwise be the same site to the browser.
check "name of another site refused"   test "$(code -H 'Host: drop.attacker.example' "http://$LAN/api/state")" = 421
check "by IP address"                  test "$(code -H "Host: $LAN" "http://$LAN/api/state")" = 200
check "by a local name"                test "$(code -H 'Host: tower.local' "http://$LAN/api/state")" = 200
check "drop-share's name refused here" test "$(code -H 'Host: drop-share.ci.test' "http://$LAN/api/state")" = 404
check "any proxy header refused"       test "$(code -H "Host: $HOST" -H 'Via: 1.1 proxy' "http://$LAN/api/state")" = 404
has_header() { curl -s -o /dev/null -D - -H "Host: $HOST" "$1" | tr -d '\r' | grep -qi "$2"; }
check "page: no framing by other sites" has_header "http://$LAN/" "^content-security-policy:.*frame-ancestors 'none'"
check "page: no type sniffing"          has_header "http://$LAN/" '^x-content-type-options: nosniff'

# Limits: nothing a guest sends can take Drop down.
check "upload bigger than the disk refused" test "$(code -H "Host: $HOST" -H 'Content-Type: application/json' \
  -d '{"name":"huge.bin","size":4611686018427387904}' "http://$LAN/api/upload/init")" = 507
check "and nothing left behind"         bash -c "! ls -A '$DATA/files' | grep -q '^\.upload-'"
python3 -c 'import json; print(json.dumps({"text": "x" * (2 * 1024 * 1024 + 1)}))' > "$WORK/long.json"
check "text field too long refused"     test "$(code -X PUT -H "Host: $HOST" -H 'Content-Type: application/json' \
  --data-binary "@$WORK/long.json" "http://$LAN/api/text/1")" = 413
check "JSON only as application/json"   test "$(code -H "Host: $HOST" -H 'Content-Type: text/plain' \
  -d '{"text":"x"}' "http://$LAN/api/text")" = 415
check "no Infinity as a size"           test "$(code -H "Host: $HOST" -H 'Content-Type: application/json' \
  -d '{"name":"i","size":Infinity}' "http://$LAN/api/upload/init")" = 400

# Resuming: the same file goes on, a changed one of the same name and size starts over.
init() { curl -sf -H "Host: $HOST" -H 'Content-Type: application/json' -d "$1" "http://$LAN/api/upload/init" \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["id"], d["resumed"])'; }
first=$(init '{"name":"same.img","size":10,"modified":1000}')
again=$(init '{"name":"same.img","size":10,"modified":1000}')
changed=$(init '{"name":"same.img","size":10,"modified":2000}')
check "resume: the same file goes on"     test "$again" = "${first% *} True"
check "resume: a changed one starts over" test "${changed% *}" != "${first% *}" -a "${changed#* }" = False
for id in "${first% *}" "${changed% *}"; do curl -s -o /dev/null -X DELETE -H "Host: $HOST" "http://$LAN/api/upload/$id"; done

# A file, uploaded the way the page does it: init, one chunk, done.
printf 'Drop smoke test %s\n' "$(date +%s)" > "$WORK/hello.txt"
size=$(stat -c %s "$WORK/hello.txt")
uid=$(curl -sf -H "Host: $HOST" -H 'Content-Type: application/json' \
  -d "{\"name\":\"hello.txt\",\"size\":$size}" "http://$LAN/api/upload/init" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
check "upload chunk" test "$(code -X PUT -H "Host: $HOST" --data-binary "@$WORK/hello.txt" "http://$LAN/api/upload/$uid/0")" = 200
check "upload done"  test "$(code -X POST -H "Host: $HOST" "http://$LAN/api/upload/$uid/done")" = 200
check "file downloads" cmp -s <(curl -sf -H "Host: $HOST" "http://$LAN/files/hello.txt") "$WORK/hello.txt"
check "downloads run nothing" has_header "http://$LAN/files/hello.txt" '^content-security-policy: sandbox'

# The share sheet (Android, Drop on the home screen) — and other sites that try the same.
check "manifest with share target" bash -c "curl -sf -H 'Host: $HOST' http://$LAN/manifest.webmanifest \
  | python3 -c 'import json,sys; assert json.load(sys.stdin)[\"share_target\"][\"action\"] == \"/share-target\"'"
check "share sheet: other sites refused"  test "$(code -H "Host: $HOST" -H 'Sec-Fetch-Site: cross-site' \
  -F "files=@$WORK/hello.txt;filename=evil.txt" "http://$LAN/share-target")" = 403
check "share sheet: unknown origin refused" test "$(code -H "Host: $HOST" \
  -F "files=@$WORK/hello.txt;filename=evil.txt" "http://$LAN/share-target")" = 403
check "share sheet: nothing stored then"  test ! -e "$DATA/files/evil.txt"
check "share sheet: accepted"             test "$(code -H "Host: $HOST" -H 'Sec-Fetch-Site: none' \
  -F "files=@$WORK/hello.txt;filename=shared.txt" -F 'text=https://example.com/shared' "http://$LAN/share-target")" = 303
check "share sheet: file in the list"     cmp -s "$DATA/files/shared.txt" "$WORK/hello.txt"
check "share sheet: link in a text field" grep -rqs 'https://example.com/shared' "$DATA/texts/"
check "share sheet: no leftovers"         bash -c "! ls -A '$DATA/files' | grep -q '^\.shared-'"

# Calls: two pages with live updates, one rings the other. Only the set-up
# messages pass through drop; it checks who may send what.
call() {   # call <path> <json> → status, the reply in $WORK/reply
  curl -s -o "$WORK/reply" -w '%{http_code}' -H "Host: $HOST" -H 'Content-Type: application/json' \
    -d "$2" "http://$LAN/api/call/$1"
}
heard() { for _ in $(seq 1 25); do grep -qs "$2" "$WORK/$1.sse" && return 0; sleep 0.2; done; return 1; }
secret() { head -c 18 /dev/urandom | base64 | tr "+/" "-_"; }
PA=$(secret) PB=$(secret)
check "calls: not without live updates" test "$(call presence "{\"peer\":\"$PA\",\"available\":true}")" = 404
curl -sN -H "Host: $HOST" "http://$LAN/api/events?peer=$PA" > "$WORK/a.sse" & SSE_A=$!
curl -sN -H "Host: $HOST" "http://$LAN/api/events?peer=$PB" > "$WORK/b.sse" & SSE_B=$!
heard a connected; heard b connected
check "calls: page A available"  test "$(call presence "{\"peer\":\"$PA\",\"name\":\"Laptop\",\"device\":\"Linux\",\"available\":true}")" = 200
check "calls: page B available"  test "$(call presence "{\"peer\":\"$PB\",\"name\":\"Phone\",\"available\":true}")" = 200
check "calls: B sees A by name"  heard b '"name": "Laptop"'
check "calls: never the secret"  bash -c "! grep -qF -- '$PA' '$WORK/b.sse'"
ID_B=$(grep -o '"id": "[0-9a-f]*", "name": "Phone"' "$WORK/a.sse" | tail -1 | cut -d'"' -f4)
check "calls: a made-up page cannot ring" test "$(call invite "{\"peer\":\"pageXXXXXXXXXXXXXXXXXXXXXXXX\",\"to\":\"$ID_B\"}")" = 404
check "calls: A rings B"         test "$(call invite "{\"peer\":\"$PA\",\"to\":\"$ID_B\",\"video\":true}")" = 200
CALL=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["call"])' "$WORK/reply")
check "calls: B is rung"         heard b '"type": "invite"'
check "calls: B is busy now"     test "$(call invite "{\"peer\":\"$PA\",\"to\":\"$ID_B\"}")" = 409
check "calls: nothing before the answer" test "$(call signal "{\"peer\":\"$PA\",\"call\":\"$CALL\",\"type\":\"offer\",\"data\":{}}")" = 409
check "calls: the caller cannot answer"  test "$(call signal "{\"peer\":\"$PA\",\"call\":\"$CALL\",\"type\":\"accept\"}")" = 409
check "calls: no other messages"  test "$(call signal "{\"peer\":\"$PB\",\"call\":\"$CALL\",\"type\":\"evil\"}")" = 400
check "calls: B answers"          test "$(call signal "{\"peer\":\"$PB\",\"call\":\"$CALL\",\"type\":\"accept\"}")" = 200
check "calls: A hears the answer" heard a '"type": "accept"'
check "calls: offer passed on"    test "$(call signal "{\"peer\":\"$PA\",\"call\":\"$CALL\",\"type\":\"offer\",\"data\":{\"sdp\":\"v=0 smoke\"}}")" = 200
check "calls: B gets the offer"   heard b 'v=0 smoke'
check "calls: too large refused"  test "$(python3 -c 'import json,sys; print(json.dumps({"peer":sys.argv[1],"call":sys.argv[2],"type":"ice","data":"x"*70000}))' "$PA" "$CALL" \
  | curl -s -o /dev/null -w '%{http_code}' -H "Host: $HOST" -H 'Content-Type: application/json' -d @- "http://$LAN/api/call/signal")" = 413
check "calls: A hangs up"         test "$(call signal "{\"peer\":\"$PA\",\"call\":\"$CALL\",\"type\":\"hangup\"}")" = 200
check "calls: B hears it"         heard b '"type": "hangup"'
check "calls: the call is gone"   test "$(call signal "{\"peer\":\"$PB\",\"call\":\"$CALL\",\"type\":\"state\",\"data\":{}}")" = 404
call invite "{\"peer\":\"$PA\",\"to\":\"$ID_B\"}" > /dev/null
check "calls: a lost hang-up does not leave both busy" \
  test "$(call presence "{\"peer\":\"$PA\",\"name\":\"Laptop\",\"available\":true,\"call\":null}")" = 200
check "calls: B hears that too"   bash -c "test \$(grep -c '\"type\": \"hangup\"' '$WORK/b.sse') = 2"
check "calls: free again"         test "$(call invite "{\"peer\":\"$PA\",\"to\":\"$ID_B\"}")" = 200
kill "$SSE_A" "$SSE_B" 2>/dev/null || true

share() {   # share <json> → token
  curl -sf -H "Host: $HOST" -H 'Content-Type: application/json' -d "$1" "http://$LAN/api/shares" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])'
}
check "sharing by IP refused" test "$(code -H 'Host: 127.0.0.1' -H 'Content-Type: application/json' \
  -d '{"kind":"text","text":"x"}' "http://$LAN/api/shares")" = 400
TEXT_TOKEN=$(share '{"kind":"text","text":"smoke text 42","duration":3600}')
FILE_TOKEN=$(share '{"kind":"file","name":"hello.txt","duration":3600}')
SECRET_TOKEN=$(share '{"kind":"text","text":"secret 7","duration":3600,"password":"pw-1234"}')
check "share tokens look right" bash -c "[[ $TEXT_TOKEN =~ ^[2-9a-z]{5}-[2-9a-z]{5}$ ]]"
check "file shared as hard link" test "$(stat -c %h "$DATA/files/hello.txt")" = 2

# Pictures: a preview for a real one, none for a broken one or a text file.
upload() {   # upload <file> <name>
  local id
  id=$(curl -sf -H "Host: $HOST" -H 'Content-Type: application/json' \
    -d "{\"name\":\"$2\",\"size\":$(stat -c %s "$1")}" "http://$LAN/api/upload/init" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
  curl -sf -o /dev/null -X PUT -H "Host: $HOST" --data-binary "@$1" "http://$LAN/api/upload/$id/0"
  curl -sf -o /dev/null -X POST -H "Host: $HOST" "http://$LAN/api/upload/$id/done"
}
# A 640×400 PNG, made without any tool beyond Python.
python3 - "$WORK/shot.png" <<'PY'
import struct, sys, zlib
w, h = 640, 400
raw = b"".join(b"\0" + bytes(v for x in range(w) for v in (x * 255 // w, y * 255 // h, 128)) for y in range(h))
chunk = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d))
open(sys.argv[1], "wb").write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
                              + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))
PY
printf 'not a picture' > "$WORK/broken.png"
printf '%%!PS-Adobe-3.0 EPSF-3.0\n%%%%BoundingBox: 0 0 100 100\n' > "$WORK/eps.png"
upload "$WORK/shot.png" "Screenshot 1.png"
upload "$WORK/broken.png" "broken.png"
upload "$WORK/eps.png" "eps.png"
thumb() { curl -s -o "$WORK/thumb" -w '%{http_code} %{content_type}' -H "Host: $HOST" "http://$LAN/api/thumb/$1?v=1"; }
check "preview of a picture"     test "$(thumb 'Screenshot%201.png')" = "200 image/webp"
check "preview is small"         python3 -c "import sys; d=open('$WORK/thumb','rb').read(); sys.exit(not (d[:4]==b'RIFF' and d[8:12]==b'WEBP' and len(d) < 40000))"
check "no preview when broken"   test "$(thumb broken.png | cut -d' ' -f1)" = 404
check "no preview for text"      test "$(thumb hello.txt | cut -d' ' -f1)" = 404
check "no preview for EPS as .png" test "$(thumb eps.png | cut -d' ' -f1)" = 404
check "EPS never reached a decoder" bash -c "! docker logs ci-drop 2>&1 | grep -q 'eps.png: not for previews'"
check "preview kept for reuse"   test "$(ls "$DATA/.thumbs" | wc -l)" = 1
check "delete picture" test "$(code -X DELETE -H "Host: $HOST" -H 'Content-Type: application/json' \
  -d '{"names":["Screenshot 1.png","broken.png","eps.png"]}' "http://$LAN/api/files")" = 200
check "its preview is gone too"  test "$(ls "$DATA/.thumbs" | wc -l)" = 0

# ---------------------------------------------------------- drop-share (public)
docker run -d --name ci-drop-share -p "$PUB:80" \
  --user 99:100 --read-only --cap-drop ALL --security-opt no-new-privileges:true \
  --tmpfs /tmp:size=16m --memory 256m --pids-limit 64 \
  --sysctl net.ipv4.ip_unprivileged_port_start=80 \
  -e MODE=public -e PORT=80 -e APP_NAME=Drop \
  -v "$DATA/shares:/data/shares:ro" -v "$DATA/shares/counters:/data/shares/counters" \
  "$IMAGE" >/dev/null
wait_healthy ci-drop-share

check "root shows nothing"       test "$(code "http://$PUB/")" = 404
check "Drop itself unreachable"  test "$(code "http://$PUB/api/state")" = 404
check "no calls in here"         test "$(code -H 'Content-Type: application/json' -d '{}' "http://$PUB/api/call/presence")" = 404
check "robots.txt"               test "$(code "http://$PUB/robots.txt")" = 200
check "text share shows"         bash -c "curl -sf http://$PUB/$TEXT_TOKEN | grep -q 'smoke text 42'"
check "token ignores case"       test "$(code "http://$PUB/${TEXT_TOKEN^^}")" = 200
check "file share downloads"     cmp -s <(curl -sf "http://$PUB/$FILE_TOKEN/download") "$WORK/hello.txt"
check "password asked first"     bash -c "! curl -sf http://$PUB/$SECRET_TOKEN | grep -q 'secret 7'"
check "no download without it"  test "$(code "http://$PUB/$SECRET_TOKEN/download")" = 303
check "unknown token"            test "$(code "http://$PUB/aaaaa-bbbbb")" = 404
check "runs without root"        test "$(docker exec ci-drop-share id -u)" = 99

# Deleting the file in Drop ends its share at once.
check "delete file" test "$(code -X DELETE -H "Host: $HOST" -H 'Content-Type: application/json' \
  -d '{"names":["hello.txt"]}' "http://$LAN/api/files")" = 200
check "its link is gone" test "$(code "http://$PUB/$FILE_TOKEN/download")" = 404

# ------------------------------------------------- attacks on the public part
check "no slash redirect"        test "$(code "http://$PUB/$TEXT_TOKEN/")" = 404

# Passwords sent in parallel: at most 10 are checked, the rest are refused.
RACE_TOKEN=$(share '{"kind":"text","text":"race","duration":3600,"password":"right-horse-1"}')
seq 30 | xargs -P 30 -I{} curl -s -o /dev/null -w '%{http_code}\n' -d password=wrong "http://$PUB/$RACE_TOKEN" > "$WORK/race"
check "parallel guesses: at most 10 checked" test "$(grep -c 403 "$WORK/race")" -le 10
check "then locked, even the right password" test "$(code -d password=right-horse-1 "http://$PUB/$RACE_TOKEN")" = 429

# File names with control characters (possible over SMB) must not break headers.
docker exec ci-drop sh -c 'printf ctl > "/data/files/$(printf "ctl\177name.txt")"; printf nl > "/data/files/$(printf "nl\nname.txt")"'
CTL_TOKEN=$(share '{"kind":"file","name":"ctl\u007fname.txt","duration":3600}')
NL_TOKEN=$(share '{"kind":"file","name":"nl\nname.txt","duration":3600}')
check "control char name: LAN download" test "$(code -H "Host: $HOST" "http://$LAN/files/ctl%7Fname.txt")" = 200
check "control char name: share link"   test "$(code "http://$PUB/$CTL_TOKEN/download")" = 200
check "newline name: share link"        test "$(code "http://$PUB/$NL_TOKEN/download")" = 200

# drop-share writes the view counters. Whatever is in them, Drop's page works.
docker exec ci-drop sh -c 'for f in /data/shares/*.json; do printf "{\"views\":\"lots\"}" > "/data/shares/counters/${f##*/}"; done'
check "garbage counters do not break the page" test "$(code -H "Host: $HOST" "http://$LAN/api/state")" = 200

# Names made over SMB: from a Mac (NFD), with a backslash, not UTF-8 at all.
docker exec ci-drop python3 -c '
import unicodedata
open("/data/files/" + unicodedata.normalize("NFD", "Grüsse.txt"), "w").write("mac")
open("/data/files/back\\slash.txt", "w").write("bs")
open(b"/data/files/caf\xe9.txt", "w").write("latin1")'
check "name from a Mac downloads"  test "$(curl -sf -H "Host: $HOST" "http://$LAN/files/Gru%CC%88sse.txt")" = mac
check "name with a backslash too"  test "$(curl -sf -H "Host: $HOST" "http://$LAN/files/back%5Cslash.txt")" = bs
check "a name not in UTF-8 does not break the page" test "$(code -H "Host: $HOST" "http://$LAN/api/state")" = 200

# Records put into shares/ by other means (drop stopped, so it cannot tidy them).
docker stop ci-drop >/dev/null
docker run --rm -v "$DATA:/data" --entrypoint python "$IMAGE" -c '
import hashlib, json, time
def put(token, **rec):
    sid = hashlib.sha256(token.encode()).hexdigest()[:32]
    rec = {"id": sid, "token": token, "kind": "file", "name": "x", "created": 0,
           "expires": time.time() + 3600, **rec}
    json.dump(rec, open(f"/data/shares/{sid}.json", "w"))
put("zzzzz-zzzzz", id="../../../../etc/hostname")
put("yyyyy-yyyyy", expires=1e30)
put("xxxxx-xxxxx", kind="text", text=["not", "a", "string"])
'
check "forged id: no file from outside" test "$(code "http://$PUB/zzzzz-zzzzz/download")" = 404
check "forged expiry: no error"         test "$(code "http://$PUB/yyyyy-yyyyy")" = 404
check "forged text: no error"           test "$(code "http://$PUB/xxxxx-xxxxx")" = 404

# ------------------------------------------------- the optional PIN
PINLAN=127.0.0.1:18082
mkdir -p "$WORK/pin"
start_pin() {   # start_pin <pin>
  docker rm -f ci-drop-pin >/dev/null 2>&1 || true
  docker run -d --name ci-drop-pin -p "$PINLAN:80" \
    --cap-drop ALL --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER --cap-add NET_BIND_SERVICE \
    --security-opt no-new-privileges:true --memory 2g --pids-limit 200 \
    -e MODE=lan -e TLS_CERT= -e SERVER_NAME=CI -e "PIN=$1" -e 'HOSTS=*.ci.test' -e SHARING=off \
    -v "$WORK/pin:/data" "$IMAGE" >/dev/null
  wait_healthy ci-drop-pin
}
start_pin 2468
check "PIN: the page asks for it"         bash -c "curl -s -H 'Host: $HOST' http://$PINLAN/ | grep -q 'name=\"pin\"'"
check "PIN: nothing else without it"      test "$(code -H "Host: $HOST" "http://$PINLAN/api/state")" = 401
check "PIN: no files without it"          test "$(code -H "Host: $HOST" "http://$PINLAN/files/x")" = 401
check "PIN, sharing off: from outside still 404" test "$(code -H "Host: $HOST" -H 'X-Forwarded-For: 203.0.113.9' "http://$PINLAN/")" = 404
check "PIN: a wrong one is refused"       test "$(code -H "Host: $HOST" -d pin=1111 "http://$PINLAN/login")" = 403
curl -s -o /dev/null -D "$WORK/pin.headers" -H "Host: $HOST" -d pin=2468 "http://$PINLAN/login"
check "PIN: the right one signs in"       grep -qiE '^set-cookie: drop_access=[0-9]+\.[0-9a-f]{64};.*httponly.*samesite=strict' "$WORK/pin.headers"
COOKIE=$(grep -i '^set-cookie: drop_access=' "$WORK/pin.headers" | sed -E 's/^[^:]*: (drop_access=[^;]*).*/\1/' | tr -d '\r')
check "PIN: signed in, Drop answers"      test "$(code -H "Host: $HOST" -b "$COOKIE" "http://$PINLAN/api/state")" = 200
check "PIN: a forged cookie is refused"   test "$(code -H "Host: $HOST" -b "${COOKIE%.*}.$(printf '0%.0s' $(seq 64))" "http://$PINLAN/api/state")" = 401
seq 30 | xargs -P 30 -I{} curl -s -o /dev/null -w '%{http_code}\n' -H "Host: $HOST" -d pin=0000 "http://$PINLAN/login" > "$WORK/pinrace"
check "PIN: parallel guesses, at most 10 checked" test "$(grep -c 403 "$WORK/pinrace")" -le 10
check "PIN: then locked, even the right one"      test "$(code -H "Host: $HOST" -d pin=2468 "http://$PINLAN/login")" = 429
check "PIN: signed-in browsers keep working"      test "$(code -H "Host: $HOST" -b "$COOKIE" "http://$PINLAN/api/state")" = 200
start_pin other-PIN-9
check "PIN: a changed PIN signs everyone out"     test "$(code -H "Host: $HOST" -b "$COOKIE" "http://$PINLAN/api/state")" = 401
check "PIN: manifest and icons stay open"         test "$(code -H "Host: $HOST" "http://$PINLAN/manifest.webmanifest")$(code -H "Host: $HOST" "http://$PINLAN/static/icon-192.png")" = 200200
check "PIN: shared while signed out → PIN page"   test "$(code -H "Host: $HOST" -H 'Sec-Fetch-Site: none' \
  -F "files=@$WORK/hello.txt;filename=pinned.txt" "http://$PINLAN/share-target")" = 303
check "PIN: and nothing stored"                   test ! -e "$WORK/pin/files/pinned.txt"

# ------------------------------------------------- users, each with an area of their own
USRLAN=127.0.0.1:18083
mkdir -p "$WORK/users"
start_users() {   # start_users <PIN of Anna> [PIN for everyone]
  docker rm -f ci-drop-users >/dev/null 2>&1 || true
  docker run -d --name ci-drop-users -p "$USRLAN:80" \
    --cap-drop ALL --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER --cap-add NET_BIND_SERVICE \
    --security-opt no-new-privileges:true --memory 2g --pids-limit 200 \
    -e MODE=lan -e TLS_CERT= -e SERVER_NAME=CI -e CHUNK_MB=1 -e "WEBUI=https://$HOST" \
    -e "USER_TEAL=Anna:$1" -e "USER_GOLD=Tom" -e "PIN=${2:-}" -v "$WORK/users:/data" "$IMAGE" >/dev/null
  wait_healthy ci-drop-users
}
cookie_of() { grep -i '^set-cookie: drop_access=' "$1" | sed -E 's/^[^:]*: (drop_access=[^;]*).*/\1/' | tr -d '\r'; }
start_users 2468
U=(-H "Host: $HOST")
check "users: the page lists them"         bash -c "curl -s -H 'Host: $HOST' http://$USRLAN/ | grep -q 'u-teal.*Anna' && curl -s -H 'Host: $HOST' http://$USRLAN/ | grep -q 'u-gold.*Tom'"
check "users: nothing without signing in"  test "$(code "${U[@]}" "http://$USRLAN/api/state")" = 401
check "users: a wrong PIN is refused"      test "$(code "${U[@]}" -d 'user=teal&pin=1111' "http://$USRLAN/login")" = 403
check "users: no sign-in from other sites" test "$(code "${U[@]}" -H 'Sec-Fetch-Site: cross-site' -d 'user=gold' "http://$USRLAN/login")" = 403
curl -s -o /dev/null -D "$WORK/anna.headers" "${U[@]}" -d 'user=teal&pin=2468' "http://$USRLAN/login"
curl -s -o /dev/null -D "$WORK/tom.headers" "${U[@]}" -d 'user=gold' "http://$USRLAN/login"
check "users: Anna signs in with her PIN"  grep -qiE '^set-cookie: drop_access=[0-9]+\.teal\.[0-9a-f]{64};.*httponly.*samesite=strict' "$WORK/anna.headers"
check "users: Tom needs none"              grep -qiE '^set-cookie: drop_access=[0-9]+\.gold\.[0-9a-f]{64};' "$WORK/tom.headers"
ANNA=$(cookie_of "$WORK/anna.headers"); TOM=$(cookie_of "$WORK/tom.headers")
check "users: a cookie cannot change hands" test "$(code "${U[@]}" -b "${ANNA/.teal./.gold.}" "http://$USRLAN/api/state")" = 401
check "users: a page opened for Tom is refused with Anna's cookie" test "$(code "${U[@]}" -b "$ANNA" -H 'X-Drop-As: gold' "http://$USRLAN/api/state")" = 401
check "users: the page in Anna's colour"   bash -c "curl -s -H 'Host: $HOST' -b '$ANNA' http://$USRLAN/ | grep -q 'data-palette=\"teal\" data-user'"
upload_as() {   # upload_as <cookie> <area> <name> <file> — prints the upload id
  curl -sf "${U[@]}" -b "$1" -H 'Content-Type: application/json' -d "{\"name\":\"$3\",\"size\":$(stat -c %s "$4")}" \
    "http://$USRLAN/api/upload/init?area=$2" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])'
}
uid=$(upload_as "$ANNA" own secret.txt "$WORK/hello.txt")
check "users: Tom cannot write into Anna's upload" test "$(code -X PUT "${U[@]}" -b "$TOM" --data-binary "@$WORK/hello.txt" "http://$USRLAN/api/upload/$uid/0")" = 404
curl -s -o /dev/null -X PUT "${U[@]}" -b "$ANNA" --data-binary "@$WORK/hello.txt" "http://$USRLAN/api/upload/$uid/0"
check "users: Anna's own upload done"      test "$(code -X POST "${U[@]}" -b "$ANNA" "http://$USRLAN/api/upload/$uid/done")" = 200
check "users: stored in her folder"        cmp -s "$WORK/users/users/Anna/files/secret.txt" "$WORK/hello.txt"
check "users: Anna downloads it"           cmp -s <(curl -sf "${U[@]}" -b "$ANNA" "http://$USRLAN/files/secret.txt?area=own") "$WORK/hello.txt"
check "users: Tom does not, in either area" test "$(code "${U[@]}" -b "$TOM" "http://$USRLAN/files/secret.txt?area=own")$(code "${U[@]}" -b "$TOM" "http://$USRLAN/files/secret.txt")" = 404404
uid=$(upload_as "$TOM" shared together.txt "$WORK/hello.txt")
curl -s -o /dev/null -X PUT "${U[@]}" -b "$TOM" --data-binary "@$WORK/hello.txt" "http://$USRLAN/api/upload/$uid/0"
curl -s -o /dev/null -X POST "${U[@]}" -b "$TOM" "http://$USRLAN/api/upload/$uid/done"
check "users: the shared area is shared"   cmp -s <(curl -sf "${U[@]}" -b "$ANNA" "http://$USRLAN/files/together.txt") "$WORK/hello.txt"
curl -s -o /dev/null -X PUT "${U[@]}" -b "$ANNA" -H 'Content-Type: application/json' -d '{"text":"only for Anna"}' "http://$USRLAN/api/text/1?area=own"
check "users: own texts stay own"          bash -c "! curl -s -H 'Host: $HOST' -b '$TOM' 'http://$USRLAN/api/state?area=own' | grep -q 'only for Anna' \
  && ! curl -s -H 'Host: $HOST' -b '$TOM' 'http://$USRLAN/api/state' | grep -q 'only for Anna' \
  && curl -s -H 'Host: $HOST' -b '$ANNA' 'http://$USRLAN/api/state?area=own' | grep -q 'only for Anna'"
sid=$(curl -sf "${U[@]}" -b "$ANNA" -H 'Content-Type: application/json' -d '{"kind":"file","name":"secret.txt","duration":3600}' \
  "http://$USRLAN/api/shares?area=own" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
check "users: Tom does not see Anna's link" bash -c "! curl -s -H 'Host: $HOST' -b '$TOM' http://$USRLAN/api/state | grep -q '$sid'"
check "users: nor can he end it"           test "$(code -X DELETE "${U[@]}" -b "$TOM" "http://$USRLAN/api/shares/$sid")" = 404
curl -s -o /dev/null -X DELETE "${U[@]}" -b "$TOM" "http://$USRLAN/api/shares"
check "users: not even with “end all”"     bash -c "curl -s -H 'Host: $HOST' -b '$ANNA' http://$USRLAN/api/state | grep -q '$sid'"
start_users 1357
check "users: a changed PIN signs her out" test "$(code "${U[@]}" -b "$ANNA" "http://$USRLAN/api/state")" = 401
check "users: and only her"                test "$(code "${U[@]}" -b "$TOM" "http://$USRLAN/api/state")" = 200
start_users 1357 4321
check "users: with PIN set, it is Tom's too" test "$(code "${U[@]}" -b "$TOM" "http://$USRLAN/api/state")$(code "${U[@]}" -d 'user=gold' "http://$USRLAN/login")" = 401403
check "users: and it lets him in"          test "$(code "${U[@]}" -d 'user=gold&pin=4321' "http://$USRLAN/login")" = 303
for _ in $(seq 10); do code "${U[@]}" -d 'user=teal&pin=0000' "http://$USRLAN/login" >/dev/null; done
check "users: guessing Anna's PIN locks only hers" \
  test "$(code "${U[@]}" -d 'user=teal&pin=1357' "http://$USRLAN/login")$(code "${U[@]}" -d 'user=gold&pin=4321' "http://$USRLAN/login")" = 429303
check "users: Tom signing in does not unlock it" test "$(code "${U[@]}" -d 'user=teal&pin=1357' "http://$USRLAN/login")" = 429
if timeout 60 docker run --rm -e MODE=lan -e 'USER_BLUE=../evil' -v "$WORK/users:/data" "$IMAGE" >"$WORK/badusers.log" 2>&1; then
  fail "starts with a user name that is a path"
fi
check "users: a bad name stops the start"  grep -q "Start aborted" "$WORK/badusers.log"

# ---------------------------------------------------- certificates from Cert Warden
# A stand-in for Cert Warden's download API serves one wildcard certificate.
# drop fetches it once, serves HTTPS with it and hands it to drop-share, which
# then serves HTTPS on 443 too; a wrong key is refused without a certificate.
CW=$WORK/cw; mkdir -p "$CW/pki" "$CW/data"
( cd "$CW/pki"
  openssl req -x509 -newkey rsa:2048 -nodes -keyout ca.key -out ca.pem -days 30 -subj /CN=ci-ca 2>/dev/null
  openssl req -newkey rsa:2048 -nodes -keyout leaf.key -out leaf.csr -subj /CN=ci.test 2>/dev/null
  printf 'subjectAltName=DNS:*.ci.test,DNS:ci.test\n' > ext
  openssl x509 -req -in leaf.csr -CA ca.pem -CAkey ca.key -CAcreateserial -out leaf.crt -days 90 -extfile ext 2>/dev/null
  cat leaf.key leaf.crt ca.pem > wild.pem )
cat > "$CW/mock.py" <<'PY'
import http.server
hits = 0
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        global hits
        if self.path == "/hits":
            self.send_response(200); self.end_headers(); self.wfile.write(str(hits).encode()); return
        if self.path != "/certwarden/api/v1/download/privatecertchains/wild":
            self.send_error(404); return
        if self.headers.get("X-API-Key") != "certkey.keykey":
            self.send_error(401); return
        hits += 1
        self.send_response(200); self.end_headers(); self.wfile.write(open("/pki/wild.pem", "rb").read())
    def log_message(self, *a): pass
http.server.HTTPServer(("0.0.0.0", 8080), H).serve_forever()
PY
docker network create ci-cw >/dev/null
docker run -d --name ci-cw --network ci-cw -v "$CW/mock.py:/mock.py:ro" -v "$CW/pki:/pki:ro" \
  --entrypoint python "$IMAGE" /mock.py >/dev/null
cw_drop() {   # cw_drop <key API key>
  docker rm -f ci-cw-drop >/dev/null 2>&1 || true
  docker run -d --name ci-cw-drop --network ci-cw -p 127.0.0.1:18090:443 \
    --cap-drop ALL --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER --cap-add NET_BIND_SERVICE \
    -e MODE=lan -e CERTWARDEN_ENDPOINT_URL=http://ci-cw:8080/certwarden/app/ -e CERT_INT_NAME=wild \
    -e CERT_INT_CERT_API=certkey -e "CERT_INT_KEY_API=$1" -v "$CW/data:/data" "$IMAGE" >/dev/null
}
cw_drop keykey
wait_healthy ci-cw-drop
check "cert warden: drop serves HTTPS with it" \
  curl -sf -o /dev/null --resolve drop.ci.test:18090:127.0.0.1 --cacert "$CW/pki/ca.pem" https://drop.ci.test:18090/api/help
check "cert warden: the keys never in the log" bash -c "! docker logs ci-cw-drop 2>&1 | grep -q keykey"
check "cert warden: the pair for drop-share"   docker exec ci-cw-drop test -s /data/shares/.tls/fullchain.pem -a -s /data/shares/.tls/privkey.pem
check "cert warden: key only for 99:100"       test "$(docker exec ci-cw-drop stat -c '%a %u:%g' /data/shares/.tls/privkey.pem)" = "600 99:100"
docker run -d --name ci-cw-share --network ci-cw -p 127.0.0.1:18091:443 -p 127.0.0.1:18092:80 \
  --user 99:100 --read-only --cap-drop ALL --tmpfs /tmp:size=16m \
  --sysctl net.ipv4.ip_unprivileged_port_start=80 -e MODE=public -e PORT=80 \
  -v "$CW/data/shares:/data/shares:ro" "$IMAGE" >/dev/null
wait_healthy ci-cw-share
check "cert warden: drop-share serves HTTPS" \
  curl -sf -o /dev/null --resolve drop-share.ci.test:18091:127.0.0.1 --cacert "$CW/pki/ca.pem" https://drop-share.ci.test:18091/robots.txt
check "cert warden: and HTTP for the proxy" test "$(code http://127.0.0.1:18092/robots.txt)" = 200
docker restart ci-cw-drop >/dev/null; wait_healthy ci-cw-drop
check "cert warden: fetched once — a wildcard for both, not again after a restart" \
  test "$(docker exec ci-cw python -c 'import urllib.request; print(urllib.request.urlopen("http://127.0.0.1:8080/hits").read().decode())')" = 1
docker run --rm -v "$WORK:/w" --entrypoint rm "$IMAGE" -rf /w/cw/data/.certwarden /w/cw/data/shares >/dev/null
cw_drop wrong
wait_healthy ci-cw-drop
check "cert warden: a wrong key — no certificate, said in the log" \
  bash -c "docker logs ci-cw-drop 2>&1 | grep -q 'answered 401' && ! docker exec ci-cw-drop test -e /data/.certwarden/fullchain.pem"

# ------------------------------------------------- the public part refuses more
if docker run --rm -e MODE=public -v "$DATA:/data:ro" "$IMAGE" >"$WORK/refused.log" 2>&1; then
  fail "public mode starts although it sees the files"
fi
check "public mode refuses the whole share" grep -q "Start aborted" "$WORK/refused.log"

echo "all checks passed"
