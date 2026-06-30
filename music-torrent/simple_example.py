#!/usr/bin/env python3
"""
Ejemplo simple: Usar MCP tools directamente
"""
import sys
import json

# Agregar path del music-torrent
sys.path.insert(0, "D:/cursos/SEED-AUDIO/radio/music-torrent")

from queue_manager import add_to_queue, get_job_status, get_queue_status

# Simular búsqueda (The Pirate Bay API)
import requests

def search(query):
    url = f"https://apibay.org/q.php?q={query}&cat=1000"
    r = requests.get(url, headers={"User-Agent": "Mozilla/5.0"}, timeout=15)
    return r.json()

def main():
    print("=== Búsqueda de Música ===\n")
    
    # Buscar
    query = "Chappell Roan"
    print(f"Buscando: {query}")
    results = search(query)
    
    # Mostrar resultados
    print("\nResultados:")
    for i, item in enumerate(results[:5], 1):
        if item.get("id") != "0":
            name = item.get("name", "N/A")
            seeds = item.get("seeders", "N/A")
            size = int(item.get("size", 0)) / (1024 * 1024)
            print(f"{i}. {name}")
            print(f"   Seeds: {seeds} | Tamaño: {size:.1f} MB")
    
    # Agregar el primero a la cola
    if results and results[0].get("id") != "0":
        item = results[0]
        name = item.get("name", "Download")
        info_hash = item.get("info_hash", "")
        magnet = f"magnet:?xt=urn:btih:{info_hash}&dn={name}"
        
        print(f"\nAgregando a la cola: {name}")
        job_id = add_to_queue(magnet, name)
        print(f"Job ID: {job_id}")
        
        # Verificar estado
        import time
        time.sleep(2)
        status = get_job_status(job_id)
        print(f"Estado: {status['status']}")
        
        # Estado de la cola
        queue_status = get_queue_status()
        print(f"\nCola: {queue_status['queued']} encolados, {queue_status['started']} descargando")

if __name__ == "__main__":
    main()
