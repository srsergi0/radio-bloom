#!/bin/bash
# Fix volume permissions
chown -R 1000:1000 "$FTP_USER_HOME/music/songs" "$FTP_USER_HOME/music/interludios" 2>/dev/null || true

# Initialize puredb paths
PASSWD_FILE="/etc/pure-ftpd/passwd/pureftpd.passwd"
PUREDB_FILE="/etc/pure-ftpd/passwd/pureftpd.pdb"
mkdir -p /etc/pure-ftpd/passwd
touch "$PASSWD_FILE"

# Create user if passwd file is empty or user doesn't exist
if [ ! -s "$PASSWD_FILE" ] || ! grep -q "^${FTP_USER_NAME}:" "$PASSWD_FILE" 2>/dev/null; then
  echo "Creating FTP user: $FTP_USER_NAME"
  mkdir -p "$FTP_USER_HOME/music"
  PWD_FILE="$(mktemp)"
  printf '%s\n%s\n' "$FTP_USER_PASS" "$FTP_USER_PASS" > "$PWD_FILE"
  pure-pw useradd "$FTP_USER_NAME" -f "$PASSWD_FILE" -m -u 1000 -g 1000 -d "$FTP_USER_HOME" < "$PWD_FILE"
  rm -f "$PWD_FILE"
  pure-pw mkdb "$PUREDB_FILE" -f "$PASSWD_FILE"
  echo "FTP user $FTP_USER_NAME created."
else
  echo "FTP user $FTP_USER_NAME already exists, rebuilding puredb."
  pure-pw mkdb "$PUREDB_FILE" -f "$PASSWD_FILE"
fi

# Start pure-ftpd in background and keep shell alive
/usr/sbin/pure-ftpd \
  -l puredb:$PUREDB_FILE \
  -P "$PUBLICHOST" \
  -p "$FTP_PASSIVE_PORTS" \
  -s -A -j -H -4 -R -G -X -x \
  -T 0 \
  -c "${FTP_MAX_CLIENTS:-50}" \
  -C "${FTP_MAX_CONNECTIONS:-20}" &

# Keep shell alive until pure-ftpd exits
trap "kill \$! 2>/dev/null; exit" SIGTERM SIGINT
wait
