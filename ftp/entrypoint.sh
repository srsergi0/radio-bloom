#!/bin/sh
# Fix volume permissions before starting FTP server
chown -R 1000:1000 "$FTP_USER_HOME/music/songs" "$FTP_USER_HOME/music/interludios" 2>/dev/null || true

# Execute base image's run.sh (handles user creation + pure-ftpd start)
exec /run.sh \
  -l puredb:/etc/pure-ftpd/pureftpd.pdb \
  -P "$PUBLICHOST" \
  -p "$FTP_PASSIVE_MIN:$FTP_PASSIVE_MAX" \
  -s -A -j -H -4 -R -G -X -x \
  -T 0 \
  -c "${FTP_MAX_CLIENTS:-50}" \
  -C "${FTP_MAX_CONNECTIONS:-20}"
