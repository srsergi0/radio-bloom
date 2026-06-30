#!/usr/bin/env python3
"""
Music Torrent Downloader
Search and download music from public torrent sources.
"""
import os
import sys
import subprocess
import argparse
from pathlib import Path

from rich.console import Console
from rich.table import Table
from rich.prompt import Prompt, IntPrompt
from rich.progress import Progress, SpinnerColumn, TextColumn

console = Console()

DOWNLOAD_DIR = Path("/data/music")
DOWNLOAD_DIR.mkdir(parents=True, exist_ok=True)


def search_1337x(query: str, limit: int = 10) -> list[dict]:
    """Search 1337x.to for music torrents."""
    import requests
    from bs4 import BeautifulSoup
    
    url = f"https://1337x.to/search/{query}/1/seeders/desc/"
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
    }
    
    try:
        resp = requests.get(url, headers=headers, timeout=15)
        resp.raise_for_status()
    except Exception as e:
        console.print(f"[red]Error searching 1337x: {e}[/red]")
        return []
    
    soup = BeautifulSoup(resp.text, "html.parser")
    results = []
    
    rows = soup.select("table.table-list tbody tr")[:limit]
    for row in rows:
        cols = row.find_all("td")
        if len(cols) < 7:
            continue
        
        name_tag = cols[0].find("a", class_=None)
        name = name_tag.text.strip() if name_tag else "Unknown"
        link = cols[0].find("a")
        detail_url = f"https://1337x.to{link['href']}" if link else ""
        
        seeds = cols[1].text.strip()
        leeches = cols[2].text.strip()
        size = cols[4].text.strip()
        
        # Get magnet link from detail page
        magnet = ""
        if detail_url:
            try:
                detail_resp = requests.get(detail_url, headers=headers, timeout=10)
                detail_soup = BeautifulSoup(detail_resp.text, "html.parser")
                magnet_link = detail_soup.select_one("a[href^='magnet:']")
                if magnet_link:
                    magnet = magnet_link["href"]
            except:
                pass
        
        results.append({
            "name": name,
            "seeds": seeds,
            "leeches": leeches,
            "size": size,
            "magnet": magnet,
            "url": detail_url,
        })
    
    return results


def search_nyaa(query: str, limit: int = 10) -> list[dict]:
    """Search nyaa.si for music torrents (good for FLAC/lossless)."""
    import requests
    from bs4 import BeautifulSoup
    
    url = f"https://nyaa.si/?f=0&c=0_0&q={query}&s=seeders&o=desc"
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
    }
    
    try:
        resp = requests.get(url, headers=headers, timeout=15)
        resp.raise_for_status()
    except Exception as e:
        console.print(f"[red]Error searching Nyaa: {e}[/red]")
        return []
    
    soup = BeautifulSoup(resp.text, "html.parser")
    results = []
    
    rows = soup.select("table.torrent-list tbody tr")[:limit]
    for row in rows:
        cols = row.find_all("td")
        if len(cols) < 5:
            continue
        
        name_tag = cols[1].find("a", title=True)
        name = name_tag["title"] if name_tag else cols[1].text.strip()
        
        magnet_tag = cols[2].find("a", href=True)
        magnet = ""
        if magnet_tag and "magnet:" in magnet_tag.get("href", ""):
            magnet = magnet_tag["href"]
        
        seeds = cols[3].text.strip()
        leeches = cols[4].text.strip()
        size = cols[3].next_sibling.text.strip() if cols[3].next_sibling else ""
        
        results.append({
            "name": name,
            "seeds": seeds,
            "leeches": leeches,
            "size": size,
            "magnet": magnet,
            "url": "",
        })
    
    return results


def search_torrents(query: str, source: str = "1337x", limit: int = 10) -> list[dict]:
    """Search for music torrents."""
    if source == "1337x":
        return search_1337x(query, limit)
    elif source == "nyaa":
        return search_nyaa(query, limit)
    else:
        console.print(f"[red]Unknown source: {source}[/red]")
        return []


def download_torrent(magnet: str, name: str = "torrent") -> bool:
    """Download torrent using aria2c."""
    safe_name = "".join(c for c in name if c.isalnum() or c in " -_").strip()[:50]
    download_path = DOWNLOAD_DIR / safe_name
    download_path.mkdir(parents=True, exist_ok=True)
    
    cmd = [
        "aria2c",
        "--dir", str(download_path),
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
    
    console.print(f"\n[bold green]Downloading:[/bold green] {name}")
    console.print(f"[dim]Path: {download_path}[/dim]\n")
    
    try:
        result = subprocess.run(cmd, capture_output=False, timeout=600)
        return result.returncode == 0
    except subprocess.TimeoutExpired:
        console.print("[yellow]Download timed out (10 min limit)[/yellow]")
        return False
    except Exception as e:
        console.print(f"[red]Download error: {e}[/red]")
        return False


def show_results(results: list[dict]):
    """Display search results in a table."""
    if not results:
        console.print("[yellow]No results found[/yellow]")
        return
    
    table = Table(title="Search Results")
    table.add_column("#", style="dim", width=3)
    table.add_column("Name", style="cyan", max_width=60)
    table.add_column("Size", style="green")
    table.add_column("Seeds", style="bright_green")
    table.add_column("Leeches", style="red")
    
    for i, r in enumerate(results, 1):
        table.add_row(
            str(i),
            r["name"][:60],
            r["size"],
            r["seeds"],
            r["leeches"],
        )
    
    console.print(table)


def interactive_mode():
    """Interactive search and download mode."""
    console.print("[bold bright_cyan]Music Torrent Downloader[/bold bright_cyan]")
    console.print("[dim]Sources: 1337x, Nyaa[/dim]\n")
    
    while True:
        console.print("\n[bold]Options:[/bold]")
        console.print("  1. Search by artist/song")
        console.print("  2. Paste magnet link directly")
        console.print("  3. Exit")
        
        choice = Prompt.ask("\nSelect", choices=["1", "2", "3"], default="1")
        
        if choice == "3":
            console.print("[dim]Bye![/dim]")
            break
        
        if choice == "1":
            query = Prompt.ask("Search query (artist - song)")
            source = Prompt.ask("Source", choices=["1337x", "nyaa"], default="1337x")
            
            with console.status("[bold green]Searching...[/bold green]"):
                results = search_torrents(query, source, limit=10)
            
            show_results(results)
            
            if results:
                idx = IntPrompt.ask("Download which? (number)", default=1)
                if 1 <= idx <= len(results):
                    selected = results[idx - 1]
                    if selected["magnet"]:
                        download_torrent(selected["magnet"], selected["name"])
                    else:
                        console.print("[red]No magnet link found for this torrent[/red]")
        
        elif choice == "2":
            magnet = Prompt.ask("Paste magnet link")
            if magnet.startswith("magnet:"):
                name = Prompt.ask("Name for download folder", default="my-download")
                download_torrent(magnet, name)
            else:
                console.print("[red]Invalid magnet link[/red]")


def main():
    parser = argparse.ArgumentParser(description="Music Torrent Downloader")
    parser.add_argument("-k", "--keyword", help="Search keyword")
    parser.add_argument("-s", "--source", choices=["1337x", "nyaa"], default="1337x")
    parser.add_argument("-m", "--magnet", help="Magnet link to download directly")
    parser.add_argument("-n", "--name", default="download", help="Name for download folder")
    parser.add_argument("-l", "--limit", type=int, default=10, help="Number of results")
    parser.add_argument("-i", "--interactive", action="store_true", help="Interactive mode")
    
    args = parser.parse_args()
    
    if args.interactive or (not args.keyword and not args.magnet):
        interactive_mode()
        return
    
    if args.magnet:
        download_torrent(args.magnet, args.name)
    elif args.keyword:
        with console.status("[bold green]Searching...[/bold green]"):
            results = search_torrents(args.keyword, args.source, args.limit)
        
        show_results(results)
        
        if results:
            idx = IntPrompt.ask("Download which? (number)", default=1)
            if 1 <= idx <= len(results):
                selected = results[idx - 1]
                if selected["magnet"]:
                    download_torrent(selected["magnet"], selected["name"])
                else:
                    console.print("[red]No magnet link found[/red]")


if __name__ == "__main__":
    main()
