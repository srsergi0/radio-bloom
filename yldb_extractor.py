#!/usr/bin/env python3
"""
yldb_extractor.py — Extrae archivos .yldb de RPFs de RDR2 escaneando por firma.
Sin necesidad de nombres de archivo — busca por patrones de datos.
"""

import os
import struct
import sys
import hashlib

RBF_BLOCK_SIZE = 512

def scan_rpf_for_yldb(rpf_path, output_dir):
    """Scan an RPF file for yldb-like data patterns and extract them."""
    with open(rpf_path, 'rb') as f:
        data = f.read()
    
    # Signature: 8 null bytes + 0x50XXXXXX + 0x50000030
    # The yldb header is:
    # [8 bytes 0x00] [4 bytes 0x50XXXXXX] [4 bytes 0x00000000] [4 bytes 0x30XXXXXX] [4 bytes 0x00000000]
    # Or more precisely: 
    # 00 00 00 00 00 00 00 00 XX XX XX 50 00 00 00 00 30 00 00 50 00 00 00 00 [count]...
    
    found = 0
    i = 0
    while i < len(data) - 24:
        # Check for 8 null bytes
        if data[i:i+8] != b'\x00' * 8:
            i += 1
            continue
        
        # Check for 0x50000000-style pointer at i+8
        if data[i+11] != 0x50:
            i += 1
            continue
        
        # Check for null at i+12 to i+15
        if data[i+12:i+16] != b'\x00\x00\x00\x00':
            i += 1
            continue
        
        # Check for 0x50000030 at i+16 (or similar)
        if data[i+19] != 0x50:
            i += 1
            continue
        
        # Read entry count at i+24
        if i + 28 > len(data):
            i += 1
            continue
        
        entry_count = struct.unpack_from('<I', data, i+24)[0]
        
        # Sanity check: entry count should be reasonable (few thousand max)
        if entry_count == 0 or entry_count > 10000:
            i += 1
            continue
        
        # Read the 0x50 pointer values
        ptr1 = struct.unpack_from('<I', data, i+8)[0]
        ptr2 = struct.unpack_from('<I', data, i+16)[0]
        
        # Calculate likely data end (approximate from offset and count)
        # yldb: strings start after header+entry table
        # Rough estimate: each entry has strings, minimal 10 bytes per entry
        est_size = entry_count * 30 + 200  # rough estimate
        
        end = i + min(est_size, len(data) - i)
        
        # Check if the data contains ~z~ or ~m~ markers (yldb text markers)
        chunk = data[i:min(i+2000, len(data))]
        has_z = b'~z~' in chunk
        has_m = b'~m~' in chunk or b'~n~' in chunk
        
        if not (has_z or has_m):
            i += 8
            continue
        
        # Calculate offset relative to data start (block-aligned)
        # yldb files are typically at block-aligned offsets in the RPF
        # But for scanning, we just need the absolute position
        
        # Determine actual size by finding the end markers
        # yldb files typically end with remaining data or specific patterns
        # Use a heuristic: look for the last string
        scan_end = min(i + 500000, len(data))  # max 500KB
        
        # Find the end by looking for trailing data pattern
        # After the strings, yldb has index/pointer data
        # Look for transition from text data to binary metadata
        end_pos = scan_end
        for pos in range(i + 200, scan_end - 16):
            if data[pos:pos+8] == b'\x00' * 8 and data[pos+11] == 0x50:
                # Next yldb starts - this is the boundary
                end_pos = pos
                break
        
        if end_pos == scan_end:
            i += 8
            continue
        
        # Extract the yldb data
        yldb_data = data[i:end_pos]
        
        # Generate a hash-based filename
        hash_name = hashlib.md5(yldb_data[:256]).hexdigest()[:16]
        out_name = f"0x{hash_name}.yldb"
        out_path = os.path.join(output_dir, out_name)
        
        # Skip if already extracted
        if os.path.exists(out_path):
            i += 8
            continue
        
        with open(out_path, 'wb') as f:
            f.write(yldb_data)
        
        found += 1
        if found <= 10 or found % 10 == 0:
            print(f"  [{found}] {out_name}: {len(yldb_data)} bytes, {entry_count} entries at 0x{i:x}")
        
        # Skip past this yldb
        i = end_pos
    
    return found

def extract_yldb_from_rpfs(game_dir, output_dir):
    """Scan all RPFs for yldb files."""
    # Known RPF files to scan (skip audio and shader RPFs)
    rpf_patterns = [
        'data_0.rpf', 'data_1.rpf',
        'levels_0.rpf', 'levels_1.rpf', 'levels_2.rpf', 
        'levels_3.rpf', 'levels_4.rpf', 'levels_5.rpf',
        'levels_6.rpf', 'levels_7.rpf', 'levels_8.rpf',
        'update_0.rpf', 'update_1.rpf', 'update_2.rpf', 'update_3.rpf', 'update_4.rpf',
        'dlc.rpf',  # May exist in dlcpacks
        'common_0.rpf', 'common_1.rpf',
        'appdata0_update.rpf',
    ]
    
    # Also scan dlcpacks subdirectories
    dlc_packs = [
        'x64\\dlcpacks\\mp001\\dlc.rpf',
        'x64\\dlcpacks\\mp002\\dlc.rpf',
        'x64\\dlcpacks\\mp003\\dlc.rpf',
    ]
    
    all_rpfs = []
    for pattern in rpf_patterns:
        path = os.path.join(game_dir, pattern)
        if os.path.exists(path):
            all_rpfs.append(path)
    
    for pattern in dlc_packs:
        path = os.path.join(game_dir, pattern)
        if os.path.exists(path):
            all_rpfs.append(path)
    
    os.makedirs(output_dir, exist_ok=True)
    total = 0
    
    for rpf_path in all_rpfs:
        size = os.path.getsize(rpf_path)
        if size > 500 * 1024 * 1024:  # Skip files > 500MB (they're levels with no text)
            print(f"\nSKIP {os.path.basename(rpf_path)}: too large ({size//1024//1024}MB)")
            continue
        
        print(f"\nScanning {os.path.basename(rpf_path)} ({size//1024//1024}MB)...")
        found = scan_rpf_for_yldb(rpf_path, output_dir)
        print(f"  Found: {found} yldb files")
        total += found
    
    print(f"\nTotal: {total} yldb files extracted to {output_dir}")

if __name__ == '__main__':
    game = r'D:\JUEGOS\PC\Steam\SteamLibrary\steamapps\common\Red Dead Redemption 2'
    output = r'D:\yldb_extraidos'
    extract_yldb_from_rpfs(game, output)
