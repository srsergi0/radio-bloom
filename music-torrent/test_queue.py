#!/usr/bin/env python3
"""
Test script for the download queue.
"""
import time
from queue_manager import add_to_queue, get_job_status, get_queue_status

def main():
    print("=== Download Queue Test ===\n")
    
    # Test search (The Pirate Bay API)
    import requests
    url = "https://apibay.org/q.php?q=Chappell Roan&cat=1000"
    headers = {"User-Agent": "Mozilla/5.0"}
    
    try:
        r = requests.get(url, headers=headers, timeout=15)
        data = r.json()
        
        if data and data[0].get("id") != "0":
            # Get first result
            item = data[0]
            name = item.get("name", "Test Download")
            info_hash = item.get("info_hash", "")
            magnet = f"magnet:?xt=urn:btih:{info_hash}&dn={name}"
            
            print(f"Found: {name}")
            print(f"Magnet: {magnet[:60]}...\n")
            
            # Add to queue
            job_id = add_to_queue(magnet, name)
            print(f"Added to queue! Job ID: {job_id}\n")
            
            # Check status
            time.sleep(2)
            status = get_job_status(job_id)
            print(f"Status: {status['status']}")
            print(f"Position: {status.get('position', 'N/A')}\n")
            
            # Check queue
            queue_status = get_queue_status()
            print("Queue Status:")
            print(f"  Queued: {queue_status['queued']}")
            print(f"  Downloading: {queue_status['started']}")
            print(f"  Completed: {queue_status['finished']}")
            
        else:
            print("No results found")
    
    except Exception as e:
        print(f"Error: {e}")

if __name__ == "__main__":
    main()
