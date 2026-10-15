#!/bin/bash
# Dropnook: fetch Drop's certificate from Cert Warden
# ===================================================
# For the "User Scripts" plugin on Unraid: Settings → User Scripts → Add New
# Script, paste this in, fill in the five values below, and pick a schedule
# (e.g. Custom: 17 4 * * *, once a day). Run it once by hand first.
#
# It fetches the certificate (with its chain) and the private key through Cert
# Warden's download API, checks that they are valid and belong together, and
# only then puts them where Drop looks for them:
#
#   <DEST>/live/drop/fullchain.pem
#   <DEST>/live/drop/privkey.pem
#
# In Drop's .env: CERTS_DIR=<DEST> and TLS_CERT=auto — never Drop's own
# appdata folder. Drop notices a renewed certificate by itself and restarts for
# a moment (once no upload or call is running). Nothing is replaced while Cert
# Warden is unreachable or answers with something that is not a fitting pair.
# https://github.com/dropnook/dropnook.app#https-in-your-network

CW_URL="https://certwarden.example.org"   # Cert Warden's address, without /certwarden/…
CERT_NAME="drop"                           # name of the certificate in Cert Warden
CERT_API_KEY=""                            # its API key
KEY_NAME="drop"                            # name of the private key in Cert Warden
KEY_API_KEY=""                             # its API key
DEST="/mnt/user/appdata/certwarden-drop"   # Drop's CERTS_DIR — a folder of its own
CW_CA=""                                   # optional: CA file, if Cert Warden's own certificate is not publicly trusted

# ---------------------------------------------------------------------------
set -u
umask 077
say() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*"; }
fail() { say "NOT UPDATED: $*"; exit 1; }

[ -n "$CERT_API_KEY" ] && [ -n "$KEY_API_KEY" ] || fail "fill in CERT_API_KEY and KEY_API_KEY at the top of the script"
case "$DEST" in
  */appdata/drop|*/appdata/drop/) fail "DEST must not be Drop's own appdata folder — drop-share can read that one" ;;
esac
for n in "$CERT_NAME" "$KEY_NAME"; do
  [[ $n =~ ^[A-Za-z0-9._~-]+$ ]] || fail "\"$n\" is not a Cert Warden name (letters, digits, . _ ~ -)"
done
command -v curl >/dev/null && command -v openssl >/dev/null || fail "curl and openssl are needed"

tmp=$(mktemp -d) || fail "no temporary folder"
trap 'rm -rf "$tmp"' EXIT
api="${CW_URL%/}/certwarden/api/v1/download"
tls=(); [ -n "$CW_CA" ] && tls=(--cacert "$CW_CA")

fetch() {   # fetch <what> <name> <key> <file>
  # The key goes in a header from a file, so it never shows in the process list.
  printf 'X-API-Key: %s\n' "$3" > "$tmp/header"
  code=$(curl -sS --max-time 30 "${tls[@]}" -H @"$tmp/header" -o "$4" -w '%{http_code}' \
    "$api/$1/$2") \
    || fail "Cert Warden not reachable at $CW_URL"
  rm -f "$tmp/header"
  [ "$code" = 200 ] || fail "Cert Warden answered $code for $1/$2 (wrong name or API key?)"
}
fetch certificates "$CERT_NAME" "$CERT_API_KEY" "$tmp/fullchain.pem"
fetch privatekeys  "$KEY_NAME"  "$KEY_API_KEY"  "$tmp/privkey.pem"

# A pair Drop can use: a certificate, valid for at least another day, and the key that belongs to it.
openssl x509 -in "$tmp/fullchain.pem" -noout 2>/dev/null || fail "no certificate in the answer for $CERT_NAME"
openssl pkey -in "$tmp/privkey.pem" -noout 2>/dev/null || fail "no private key in the answer for $KEY_NAME"
openssl x509 -in "$tmp/fullchain.pem" -noout -checkend 86400 >/dev/null || fail "the certificate expires within a day"
[ "$(openssl x509 -in "$tmp/fullchain.pem" -noout -pubkey | openssl pkey -pubin -outform DER 2>/dev/null | openssl sha256)" = \
  "$(openssl pkey -in "$tmp/privkey.pem" -pubout -outform DER 2>/dev/null | openssl sha256)" ] \
  || fail "the key $KEY_NAME does not belong to the certificate $CERT_NAME"

dir="$DEST/live/drop"
if cmp -s "$tmp/fullchain.pem" "$dir/fullchain.pem" && cmp -s "$tmp/privkey.pem" "$dir/privkey.pem"; then
  say "unchanged, valid until $(openssl x509 -in "$dir/fullchain.pem" -noout -enddate | cut -d= -f2)"
  exit 0
fi

mkdir -p "$dir" && chmod 755 "$DEST" "$DEST/live" "$dir" || fail "cannot create $dir"
# Key first, certificate last: Drop reacts to the certificate changing, and by
# then the key that belongs to it is already in place.
for f in privkey.pem fullchain.pem; do
  cp "$tmp/$f" "$dir/.$f.new" && chmod 600 "$dir/.$f.new" && mv -f "$dir/.$f.new" "$dir/$f" \
    || fail "cannot write $dir/$f"
done
chmod 644 "$dir/fullchain.pem"
say "updated: $(openssl x509 -in "$dir/fullchain.pem" -noout -subject -enddate | tr '\n' ' ')"
