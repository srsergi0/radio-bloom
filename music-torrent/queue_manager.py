#!/usr/bin/env python3
"""
Download Queue Manager
Handles sequential downloads using Redis + RQ.
"""
import os
import time
import json
from datetime import datetime
from typing import Optional

import redis
from rq import Queue, Worker, Connection
from rq.job import Job

# Redis connection
REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379/0")
redis_conn = redis.from_url(REDIS_URL)
q = Queue(connection=redis_conn)

# Download directory
DOWNLOAD_DIR = os.getenv("DOWNLOAD_DIR", "/data/music")
os.makedirs(DOWNLOAD_DIR, exist_ok=True)


def download_task(magnet: str, name: str, job_id: str) -> dict:
    """
    Task to download a torrent. Runs in worker process.
    Updates job metadata with progress.
    """
    import subprocess
    
    job = Job.fetch(job_id, connection=redis_conn)
    
    # Update status
    job.meta["status"] = "downloading"
    job.meta["started_at"] = datetime.now().isoformat()
    job.save()
    
    # Prepare download path
    safe_name = "".join(c for c in name if c.isalnum() or c in " -_").strip()[:50]
    download_path = os.path.join(DOWNLOAD_DIR, safe_name)
    os.makedirs(download_path, exist_ok=True)
    
    # aria2c command
    cmd = [
        "aria2c",
        "--dir", download_path,
        "--seed-time=0",
        "--bt-stop-timeout=600",
        "--max-connection-per-server=16",
        "--split=16",
        "--continue=true",
        "--daemon=false",
        "--summary-interval=5",
        "--console-log-level=notice",
        "--on-download-complete=/app/scripts/on_complete.sh",
        magnet,
    ]
    
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=900)
        
        if result.returncode == 0:
            # List downloaded files
            files = []
            for f in os.listdir(download_path):
                if f.endswith(('.mp3', '.flac', '.wav', '.m4a', '.ogg', '.opus')):
                    files.append(f)
            
            job.meta["status"] = "completed"
            job.meta["completed_at"] = datetime.now().isoformat()
            job.meta["files"] = files
            job.meta["path"] = download_path
            job.save()
            
            return {
                "status": "completed",
                "path": download_path,
                "files": files
            }
        else:
            job.meta["status"] = "failed"
            job.meta["error"] = result.stderr
            job.save()
            
            return {
                "status": "failed",
                "error": result.stderr
            }
    
    except subprocess.TimeoutExpired:
        job.meta["status"] = "timeout"
        job.meta["error"] = "Download timed out (15 min)"
        job.save()
        
        return {
            "status": "timeout",
            "error": "Download timed out"
        }
    
    except Exception as e:
        job.meta["status"] = "error"
        job.meta["error"] = str(e)
        job.save()
        
        return {
            "status": "error",
            "error": str(e)
        }


def add_to_queue(magnet: str, name: str, priority: int = 0) -> str:
    """
    Add a download to the queue.
    Returns job ID for tracking.
    """
    job = q.enqueue(
        download_task,
        args=(magnet, name, "pending"),
        kwargs={},
        job_timeout=900,  # 15 min timeout
        result_ttl=86400,  # Keep results for 24h
        failure_ttl=86400,
    )
    
    # Update job meta with initial data
    job.meta["magnet"] = magnet
    job.meta["name"] = name
    job.meta["status"] = "queued"
    job.meta["queued_at"] = datetime.now().isoformat()
    job.meta["position"] = len(q) + 1
    job.save()
    
    # Update the job_id argument in the task
    # (We pass it as argument but also store in meta)
    
    return job.id


def get_job_status(job_id: str) -> Optional[dict]:
    """Get status of a queued download."""
    try:
        job = Job.fetch(job_id, connection=redis_conn)
        return {
            "id": job.id,
            "name": job.meta.get("name", "Unknown"),
            "status": job.meta.get("status", "unknown"),
            "queued_at": job.meta.get("queued_at"),
            "started_at": job.meta.get("started_at"),
            "completed_at": job.meta.get("completed_at"),
            "files": job.meta.get("files", []),
            "path": job.meta.get("path"),
            "error": job.meta.get("error"),
            "position": job.meta.get("position"),
        }
    except Exception:
        return None


def get_queue_status() -> dict:
    """Get overall queue status."""
    return {
        "queued": len(q),
        "started": len(q.started_job_registry),
        "finished": len(q.finished_job_registry),
        "failed": len(q.failed_job_registry),
        "deferred": len(q.deferred_job_registry),
    }


def list_queue_items() -> list:
    """List all jobs in queue with their status."""
    jobs = []
    
    # Get queued jobs
    for job in q.jobs:
        jobs.append({
            "id": job.id,
            "name": job.meta.get("name", "Unknown"),
            "status": "queued",
            "position": q.job_ids.index(job.id) + 1 if job.id in q.job_ids else 0,
        })
    
    # Get started jobs
    for job_id in q.started_job_registry.get_job_ids():
        job = Job.fetch(job_id, connection=redis_conn)
        jobs.append({
            "id": job.id,
            "name": job.meta.get("name", "Unknown"),
            "status": "downloading",
        })
    
    # Get recent completed jobs
    for job_id in q.finished_job_registry.get_job_ids()[:5]:
        job = Job.fetch(job_id, connection=redis_conn)
        jobs.append({
            "id": job.id,
            "name": job.meta.get("name", "Unknown"),
            "status": "completed",
            "files": job.meta.get("files", []),
        })
    
    return jobs


def cancel_job(job_id: str) -> bool:
    """Cancel a queued job."""
    try:
        job = Job.fetch(job_id, connection=redis_conn)
        if job.get_status() == "queued":
            job.cancel()
            return True
        return False
    except Exception:
        return False
