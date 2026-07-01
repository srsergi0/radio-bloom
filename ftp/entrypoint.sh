#!/bin/sh
# Fix volume permissions before starting FTP server
chown -R 1000:1000 "$FTP_USER_HOME/music/songs" "$FTP_USER_HOME/music/interludios" 2>/dev/null || true

# Initialize puredb
mkdir -p /etc/pure-ftpd/passwd
chmod 777 /etc/pure-ftpd/passwd
PASSWD_FILE="/etc/pure-ftpd/passwd/pureftpd.passwd"
PUREDB_FILE="/etc/pure-ftpd/passwd/pureftpd.pdb"
touch "$PASSWD_FILE"

# Create user if not already in puredb
if ! pure-pw list -f "$PASSWD_FILE" 2>/dev/null | grep -q "^${FTP_USER_NAME}"; then
  echo "Creating FTP user: $FTP_USER_NAME"
  mkdir -p "$FTP_USER_HOME/music"
  PWD_FILE="$(mktemp)"
  printf '%s\n%s\n' "$FTP_USER_PASS" "$FTP_USER_PASS" > "$PWD_FILE"
  pure-pw useradd "$FTP_USER_NAME" -f "$PASSWD_FILE" -m -u 1000 -g 1000 -d "$FTP_USER_HOME" < "$PWD_FILE"
  rm -f "$PWD_FILE"
  pure-pw mkdb "$PUREDB_FILE" -f "$PASSWD_FILE"
  echo "FTP user $FTP_USER_NAME created."
fi

# Start pure-ftpd directly (skip run.sh to avoid user creation conflicts)
exec pure-ftpd \
  -l puredb:$PUREDB_FILE \
  -P "$PUBLICHOST" \
  -p "$FTP_PASSIVE_MIN:$FTP_PASSIVE_MAX" \
  -s -A -j -H -4 -R -G -X -x \
  -T 0 \
  -c "${FTP_MAX_CLIENTS:-50}" \
  -C "${FTP_MAX_CONNECTIONS:-20}"
