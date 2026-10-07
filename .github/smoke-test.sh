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
  docker rm -f ci-drop ci-drop-share ci-drop-pin >/dev/null 2>&1 || true
  # The containers own the files (99:100); remove them from inside.
  docker run --rm -v "$WORK:/w" --entrypoint rm "$IMAGE" -rf /w/data /w/pin >/dev/null 2>&1 || true
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

# ---------------------------------------------------------------- drop (LAN)
docker run -d --name ci-drop -p "$LAN:80" \
  --cap-drop ALL --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER --cap-add NET_BIND_SERVICE \
  --security-opt no-new-privileges:true --memory 2g --pids-limit 200 \
  -e MODE=lan -e TLS_CERT= -e SERVER_NAME=CI -e CHUNK_MB=1 \
  -v "$DATA:/data" "$IMAGE" >/dev/null
wait_healthy ci-drop

check "page loads"              test "$(code -H "Host: $HOST" "http://$LAN/")" = 200
check "state answers"           test "$(code -H "Host: $HOST" "http://$LAN/api/state")" = 200
check "proxied request refused" test "$(code -H "Host: $HOST" -H 'X-Forwarded-For: 203.0.113.9' "http://$LAN/api/state")" = 404
check "data folders created"    test -d "$DATA/files" -a -d "$DATA/texts" -a -d "$DATA/shares/counters"

# A file, uploaded the way the page does it: init, one chunk, done.
printf 'Drop smoke test %s\n' "$(date +%s)" > "$WORK/hello.txt"
size=$(stat -c %s "$WORK/hello.txt")
uid=$(curl -sf -H "Host: $HOST" -H 'Content-Type: application/json' \
  -d "{\"name\":\"hello.txt\",\"size\":$size}" "http://$LAN/api/upload/init" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
check "upload chunk" test "$(code -X PUT -H "Host: $HOST" --data-binary "@$WORK/hello.txt" "http://$LAN/api/upload/$uid/0")" = 200
check "upload done"  test "$(code -X POST -H "Host: $HOST" "http://$LAN/api/upload/$uid/done")" = 200
check "file downloads" cmp -s <(curl -sf -H "Host: $HOST" "http://$LAN/files/hello.txt") "$WORK/hello.txt"

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
    -e MODE=lan -e TLS_CERT= -e SERVER_NAME=CI -e "PIN=$1" -v "$WORK/pin:/data" "$IMAGE" >/dev/null
  wait_healthy ci-drop-pin
}
start_pin 2468
check "PIN: the page asks for it"         bash -c "curl -s -H 'Host: $HOST' http://$PINLAN/ | grep -q 'name=\"pin\"'"
check "PIN: nothing else without it"      test "$(code -H "Host: $HOST" "http://$PINLAN/api/state")" = 401
check "PIN: no files without it"          test "$(code -H "Host: $HOST" "http://$PINLAN/files/x")" = 401
check "PIN: from outside still 404"       test "$(code -H "Host: $HOST" -H 'X-Forwarded-For: 203.0.113.9' "http://$PINLAN/")" = 404
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

# ------------------------------------------------- the public part refuses more
if docker run --rm -e MODE=public -v "$DATA:/data:ro" "$IMAGE" >"$WORK/refused.log" 2>&1; then
  fail "public mode starts although it sees the files"
fi
check "public mode refuses the whole share" grep -q "Start aborted" "$WORK/refused.log"

echo "all checks passed"
