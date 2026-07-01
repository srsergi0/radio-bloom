FROM stilliard/pure-ftpd:hardened

CMD ["/bin/sh", "-c", "/run.sh -l puredb:/etc/pure-ftpd/pureftpd.pdb -P $PUBLICHOST -p $FTP_PASSIVE_MIN:$FTP_PASSIVE_MAX -s -A -j -H -4 -R -G -X -x"]
