#!/usr/bin/env python3
"""
MCP Server with Queue Integration
Search torrents and add downloads to queue.
"""
import os
import json
from typing import Any

from mcp.server import Server
from mcp.types import Tool, TextContent
import mcp.server.stdio

from queue_manager import add_to_queue, get_job_status, get_queue_status, list_queue_items, cancel_job

# Create MCP server
server = Server("music-torrent-queue")


@server.list_tools()
async def list_tools() -> list[Tool]:
    """List available tools."""
    return [
        Tool(
            name="search_torrents",
            description="Search for music torrents on The Pirate Bay",
            inputSchema={
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Search query (artist - song name)"
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Number of results (default: 5)",
                        "default": 5
                    }
                },
                "required": ["query"]
            }
        ),
        Tool(
            name="queue_download",
            description="Add a torrent download to the queue",
            inputSchema={
                "type": "object",
                "properties": {
                    "magnet": {
                        "type": "string",
                        "description": "Magnet link"
                    },
                    "name": {
                        "type": "string",
                        "description": "Name for download"
                    }
                },
                "required": ["magnet", "name"]
            }
        ),
        Tool(
            name="check_status",
            description="Check status of a queued download",
            inputSchema={
                "type": "object",
                "properties": {
                    "job_id": {
                        "type": "string",
                        "description": "Job ID from queue_download"
                    }
                },
                "required": ["job_id"]
            }
        ),
        Tool(
            name="queue_status",
            description="Get overall queue status",
            inputSchema={
                "type": "object",
                "properties": {},
                "required": []
            }
        ),
        Tool(
            name="list_queue",
            description="List all items in queue",
            inputSchema={
                "type": "object",
                "properties": {},
                "required": []
            }
        ),
        Tool(
            name="cancel_download",
            description="Cancel a queued download",
            inputSchema={
                "type": "object",
                "properties": {
                    "job_id": {
                        "type": "string",
                        "description": "Job ID to cancel"
                    }
                },
                "required": ["job_id"]
            }
        )
    ]


@server.call_tool()
async def call_tool(name: str, arguments: dict[str, Any]) -> list[TextContent]:
    """Handle tool calls."""
    if name == "search_torrents":
        return await search_torrents(arguments["query"], arguments.get("limit", 5))
    elif name == "queue_download":
        return await queue_download(arguments["magnet"], arguments["name"])
    elif name == "check_status":
        return await check_status(arguments["job_id"])
    elif name == "queue_status":
        return await queue_status()
    elif name == "list_queue":
        return await list_queue()
    elif name == "cancel_download":
        return await cancel_download(arguments["job_id"])
    else:
        return [TextContent(type="text", text=f"Unknown tool: {name}")]


async def search_torrents(query: str, limit: int = 5) -> list[TextContent]:
    """Search for music torrents."""
    import requests
    
    url = f"https://apibay.org/q.php?q={query}&cat=1000"
    headers = {"User-Agent": "Mozilla/5.0"}
    
    try:
        r = requests.get(url, headers=headers, timeout=15)
        data = r.json()
        
        results = []
        for item in data[:limit]:
            if item.get("id") != "0":
                name = item.get("name", "N/A")
                seeds = item.get("seeders", "N/A")
                size = int(item.get("size", 0)) / (1024 * 1024)
                info_hash = item.get("info_hash", "")
                if info_hash:
                    magnet = f"magnet:?xt=urn:btih:{info_hash}&dn={name}"
                else:
                    magnet = ""
                
                results.append({
                    "name": name,
                    "seeds": seeds,
                    "size": f"{size:.1f} MB",
                    "magnet": magnet
                })
        
        if results:
            text = "Found torrents:\n\n"
            for i, r in enumerate(results, 1):
                text += f"{i}. {r['name']}\n"
                text += f"   Seeds: {r['seeds']} | Size: {r['size']}\n"
                text += f"   Magnet: {r['magnet'][:80]}...\n\n"
            text += "Use queue_download to add any of these to the download queue."
            return [TextContent(type="text", text=text)]
        else:
            return [TextContent(type="text", text="No torrents found")]
    
    except Exception as e:
        return [TextContent(type="text", text=f"Error searching: {e}")]


async def queue_download(magnet: str, name: str) -> list[TextContent]:
    """Add download to queue."""
    job_id = add_to_queue(magnet, name)
    
    status = get_queue_status()
    
    text = f"Download added to queue!\n\n"
    text += f"Job ID: {job_id}\n"
    text += f"Name: {name}\n"
    text += f"Queue position: {status['queued']}\n\n"
    text += f"Use check_status with job_id '{job_id}' to track progress."
    
    return [TextContent(type="text", text=text)]


async def check_status(job_id: str) -> list[TextContent]:
    """Check download status."""
    status = get_job_status(job_id)
    
    if not status:
        return [TextContent(type="text", text=f"Job {job_id} not found")]
    
    text = f"Download Status\n\n"
    text += f"ID: {status['id']}\n"
    text += f"Name: {status['name']}\n"
    text += f"Status: {status['status'].upper()}\n"
    
    if status.get("queued_at"):
        text += f"Queued: {status['queued_at']}\n"
    if status.get("started_at"):
        text += f"Started: {status['started_at']}\n"
    if status.get("completed_at"):
        text += f"Completed: {status['completed_at']}\n"
    if status.get("files"):
        text += f"\nDownloaded files:\n"
        for f in status["files"]:
            text += f"  - {f}\n"
    if status.get("path"):
        text += f"\nPath: {status['path']}\n"
    if status.get("error"):
        text += f"\nError: {status['error']}\n"
    
    return [TextContent(type="text", text=text)]


async def queue_status() -> list[TextContent]:
    """Get queue status."""
    status = get_queue_status()
    
    text = "Queue Status\n\n"
    text += f"Queued: {status['queued']}\n"
    text += f"Downloading: {status['started']}\n"
    text += f"Completed: {status['finished']}\n"
    text += f"Failed: {status['failed']}\n"
    
    return [TextContent(type="text", text=text)]


async def list_queue() -> list[TextContent]:
    """List queue items."""
    items = list_queue_items()
    
    if not items:
        return [TextContent(type="text", text="Queue is empty")]
    
    text = "Queue Items\n\n"
    for item in items:
        text += f"- {item['name']} [{item['status']}]\n"
        if item.get("position"):
            text += f"  Position: {item['position']}\n"
        if item.get("files"):
            text += f"  Files: {', '.join(item['files'])}\n"
        text += f"  ID: {item['id']}\n\n"
    
    return [TextContent(type="text", text=text)]


async def cancel_download(job_id: str) -> list[TextContent]:
    """Cancel a queued download."""
    success = cancel_job(job_id)
    
    if success:
        return [TextContent(type="text", text=f"Job {job_id} cancelled")]
    else:
        return [TextContent(type="text", text=f"Could not cancel job {job_id} (may already be downloading)")]


async def main():
    """Run the MCP server."""
    async with mcp.server.stdio.stdio_server() as (read_stream, write_stream):
        await server.run(read_stream, write_stream, server.create_initialization_options())


if __name__ == "__main__":
    import asyncio
    asyncio.run(main())
