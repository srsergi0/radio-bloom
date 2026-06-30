#!/usr/bin/env python3
"""
MCP Server for Music Torrent Search and Download
Exposes tools that an LLM can use via MCP protocol.
"""
import os
import json
import subprocess
from typing import Any

from mcp.server import Server
from mcp.types import Tool, TextContent
import mcp.server.stdio

# Create MCP server
server = Server("music-torrent")


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
            name="download_torrent",
            description="Download a torrent by magnet link",
            inputSchema={
                "type": "object",
                "properties": {
                    "magnet": {
                        "type": "string",
                        "description": "Magnet link"
                    },
                    "name": {
                        "type": "string",
                        "description": "Name for download folder"
                    }
                },
                "required": ["magnet"]
            }
        ),
        Tool(
            name="list_downloads",
            description="List downloaded music files",
            inputSchema={
                "type": "object",
                "properties": {},
                "required": []
            }
        )
    ]


@server.call_tool()
async def call_tool(name: str, arguments: dict[str, Any]) -> list[TextContent]:
    """Handle tool calls."""
    if name == "search_torrents":
        return await search_torrents(arguments["query"], arguments.get("limit", 5))
    elif name == "download_torrent":
        return await download_torrent(arguments["magnet"], arguments.get("name", "download"))
    elif name == "list_downloads":
        return await list_downloads()
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
                magnet = item.get("info_hash", "")
                if magnet:
                    magnet = f"magnet:?xt=urn:btih:{magnet}&dn={name}"
                
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
            return [TextContent(type="text", text=text)]
        else:
            return [TextContent(type="text", text="No torrents found")]
    
    except Exception as e:
        return [TextContent(type="text", text=f"Error searching: {e}")]


async def download_torrent(magnet: str, name: str = "download") -> list[TextContent]:
    """Download a torrent using aria2."""
    download_dir = os.getenv("DOWNLOAD_DIR", "/data/music")
    os.makedirs(download_dir, exist_ok=True)
    
    safe_name = "".join(c for c in name if c.isalnum() or c in " -_").strip()[:50]
    download_path = os.path.join(download_dir, safe_name)
    os.makedirs(download_path, exist_ok=True)
    
    cmd = [
        "aria2c",
        "--dir", download_path,
        "--seed-time=0",
        "--bt-stop-timeout=300",
        "--max-connection-per-server=16",
        "--split=16",
        "--continue=true",
        "--daemon=false",
        "--summary-interval=0",
        "--console-log-level=warn",
        magnet,
    ]
    
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
        if result.returncode == 0:
            return [TextContent(type="text", text=f"Downloaded to: {download_path}")]
        else:
            return [TextContent(type="text", text=f"Download failed: {result.stderr}")]
    except subprocess.TimeoutExpired:
        return [TextContent(type="text", text="Download timed out (10 min limit)")]
    except Exception as e:
        return [TextContent(type="text", text=f"Download error: {e}")]


async def list_downloads() -> list[TextContent]:
    """List downloaded music files."""
    download_dir = os.getenv("DOWNLOAD_DIR", "/data/music")
    
    if not os.path.exists(download_dir):
        return [TextContent(type="text", text="No downloads directory found")]
    
    files = []
    for root, dirs, filenames in os.walk(download_dir):
        for f in filenames:
            if f.endswith(('.mp3', '.flac', '.wav', '.m4a', '.ogg')):
                path = os.path.join(root, f)
                size = os.path.getsize(path) / (1024 * 1024)
                files.append({"name": f, "size": f"{size:.1f} MB", "path": path})
    
    if files:
        text = "Downloaded music:\n\n"
        for i, f in enumerate(files, 1):
            text += f"{i}. {f['name']} ({f['size']})\n"
        return [TextContent(type="text", text=text)]
    else:
        return [TextContent(type="text", text="No music files downloaded yet")]


async def main():
    """Run the MCP server."""
    async with mcp.server.stdio.stdio_server() as (read_stream, write_stream):
        await server.run(read_stream, write_stream, server.create_initialization_options())


if __name__ == "__main__":
    import asyncio
    asyncio.run(main())
