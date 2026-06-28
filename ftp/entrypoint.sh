#!/bin/sh
# Fix volume permissions before starting FTP server
chown -R 1000:1000 "$FTP_USER_HOME/music/songs" "$FTP_USER_HOME/music/interludios" 2>/dev/null || true

# Execute original command
exec "$@"
