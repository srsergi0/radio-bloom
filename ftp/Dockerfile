FROM stilliard/pure-ftpd:hardened

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["/bin/sh", "-c", "/run.sh -l puredb:/etc/pure-ftpd/pureftpd.pdb -P $PUBLICHOST -p $FTP_PASSIVE_MIN:$FTP_PASSIVE_MAX -s -A -j -Z -H -4 -R -G -X -x -T 0 -c 50 -C 20"]
