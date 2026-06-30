#!/usr/bin/env python3
"""
RQ Worker for processing download queue.
Run this as a separate process.
"""
import os
import sys

import redis
from rq import Worker, Queue, Connection

# Redis connection
REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379/0")

def main():
    """Start the RQ worker."""
    conn = redis.from_url(REDIS_URL)
    
    with Connection(conn):
        worker = Worker(
            queues=[Queue(connection=conn)],
            connection=conn,
        )
        
        print(f"Starting worker on {REDIS_URL}")
        print(f"Listening on queue: default")
        print("Press Ctrl+C to stop\n")
        
        try:
            worker.work()
        except KeyboardInterrupt:
            print("\nWorker stopped")
            sys.exit(0)

if __name__ == "__main__":
    main()
