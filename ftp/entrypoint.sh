#!/bin/sh
# Fix volume permissions before starting FTP server
chown -R 1000:1000 "$FTP_USER_HOME/music/songs" "$FTP_USER_HOME/music/interludios" 2>/dev/null || true

# Remove stale puredb so /run.sh can recreate user cleanly
rm -f /etc/pure-ftpd/passwd/pureftpd.pdb /etc/pure-ftpd/passwd/pureftpd.passwd /etc/pure-ftpd/passwd/pureftpd.passwd.tmp 2>/dev/null

# Execute original command (run.sh handles user creation)
exec "$@"
