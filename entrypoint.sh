#!/bin/sh
# Starts Drop. In the drop box (MODE=lan, running as root) it first prepares
# the data folders: creates what is missing, with the owner PUID:PGID, and
# leaves alone whatever is there. drop-share (MODE=public) runs as 99:100 on a
# read-only file system and goes straight to the app.
set -e

if [ "${MODE:-lan}" != "public" ] && [ "$(id -u)" = "0" ]; then
  owner="${PUID:-99}:${PGID:-100}"
  files="${FILES_DIR:-/data/files}"
  texts="${TEXTS_DIR:-/data/texts}"
  shares="${SHARES_DIR:-/data/shares}"

  # Early test builds used German folder names; rename them once.
  if [ -d /data ]; then
    for pair in dateien:files texte:texts freigaben:shares \
                shares/dateien:shares/files shares/zaehler:shares/counters \
                texts/.felder:texts/.fields shares/.schluessel:shares/.key; do
      old="/data/${pair%%:*}"; new="/data/${pair##*:}"
      if [ -e "$old" ] && [ ! -e "$new" ]; then
        mv "$old" "$new"
        echo "drop: renamed $old → $new"
      fi
    done
  fi

  # Only the folders themselves, not recursive: a start with many files must
  # not crawl through all of them. What Drop creates later gets the owner anyway.
  # shares/ has to exist with this owner before drop-share mounts it — otherwise
  # Docker would create it as root and drop-share could not write its counters.
  mkdir -p "$files" "$texts" "$shares/files" "$shares/counters"
  chown "$owner" "$files" "$texts" "$shares" "$shares/files" "$shares/counters"
  if [ "$(dirname "$files")" = /data ]; then chown "$owner" /data; fi
  chmod 755 "$shares" "$shares/files" "$shares/counters"
  echo "drop: data folders are ready."
fi

exec python /app/main.py "$@"
