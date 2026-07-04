#!/usr/bin/env python3
"""
RPF8 Extractor for RDR2 — extracts .yldb files from RPF archives.
Based on CodeWalker by dexyfex.
"""

import os
import struct
import sys

RBF_BLOCK_SIZE = 512

class RpfEntry:
    def __init__(self):
        self.name = ""
        self.name_offset = 0

class RpfDirectory(RpfEntry):
    def __init__(self):
        super().__init__()
        self.entries_index = 0
        self.entries_count = 0
        self.children = []

class RpfBinaryFile(RpfEntry):
    def __init__(self):
        super().__init__()
        self.file_offset = 0
        self.file_size = 0
        self.uncompressed_size = 0
        self.encrypted = False

class RpfResourceFile(RpfEntry):
    def __init__(self):
        super().__init__()
        # complex structure, skip for now

def read_rpf(path):
    """Parse an RPF file and return the directory tree."""
    with open(path, 'rb') as f:
        data = f.read()
    
    rdr = DataReader(data)
    
    # Read header
    magic = rdr.read_u32()
    entry_count = rdr.read_u32()
    names_length = rdr.read_u32()
    encryption = rdr.read_u32()
    
    # Check magic
    if magic not in [0x52504637, 0x38504652]:  # RPF7 or RPF8
        return None, f"Unknown magic: 0x{magic:08X}"
    
    # Read entries data
    entries_data = rdr.read(entry_count * 16)
    names_data = rdr.read(names_length)
    
    # Parse entries
    entries = []
    erdr = DataReader(entries_data)
    for i in range(entry_count):
        buf = erdr.read_u64()
        name_offset = buf & 0xFFFF
        # Determine entry type from the upper 32 bits
        upper = (buf >> 32) & 0xFFFFFFFF
        lower = buf & 0xFFFFFFFF
        
        if upper == 0x7FFFFF00:
            # Directory entry
            e = RpfDirectory()
            e.name_offset = name_offset
            e.entries_index = erdr.read_u32()
            e.entries_count = erdr.read_u32()
        elif (upper & 0x80000000) == 0:
            # Binary file entry
            e = RpfBinaryFile()
            # Packed: name_offset(16) | file_size(24) | file_offset(24)  
            e.file_size = (buf >> 16) & 0xFFFFFF
            e.file_offset = (buf >> 40) & 0xFFFFFF
            e.name_offset = buf & 0xFFFF
            e.uncompressed_size = erdr.read_u32()
            enc = erdr.read_u32()
            e.encrypted = (enc != 0)
        else:
            # Resource file entry - skip remaining 8 bytes
            e = RpfResourceFile()
            e.name_offset = name_offset
            erdr.skip(8)
        
        # Read name from names data
        if e.name_offset < len(names_data):
            end = names_data.find(b'\x00', e.name_offset)
            if end > e.name_offset:
                e.name = names_data[e.name_offset:end].decode('ascii', errors='replace')
        
        entries.append(e)
    
    # Build directory tree
    if len(entries) > 0 and isinstance(entries[0], RpfDirectory):
        root = entries[0]
        _build_tree(root, entries)
        return root, None
    
    return None, "First entry is not a directory"

def _build_tree(dir_entry, all_entries):
    """Recursively build directory tree."""
    start = int(dir_entry.entries_index)
    end = start + int(dir_entry.entries_count)
    
    for i in range(start, min(end, len(all_entries))):
        e = all_entries[i]
        if isinstance(e, RpfDirectory):
            _build_tree(e, all_entries)
        dir_entry.children.append(e)

class DataReader:
    def __init__(self, data):
        self.data = data
        self.pos = 0
    
    def read(self, n):
        result = self.data[self.pos:self.pos+n]
        self.pos += n
        return result
    
    def read_u32(self):
        val = struct.unpack_from('<I', self.data, self.pos)[0]
        self.pos += 4
        return val
    
    def read_u64(self):
        val = struct.unpack_from('<Q', self.data, self.pos)[0]
        self.pos += 8
        return val
    
    def skip(self, n):
        self.pos += n

def extract_yldb_files(rpf_path, output_dir):
    """Extract all .yldb files from an RPF archive."""
    root, err = read_rpf(path)
    if err:
        return 0, err
    
    count = 0
    _extract_recursive(root, rpf_path, output_dir, "", count)
    # Can't easily return count from recursive, let me fix this
    return count, None

def _extract_recursive(dir_entry, rpf_path, output_dir, current_path, count_ref):
    """Recursively find and extract .yldb files."""
    for child in dir_entry.children:
        if isinstance(child, RpfDirectory):
            subpath = f"{current_path}/{child.name}" if current_path else child.name
            _extract_recursive(child, rpf_path, output_dir, subpath, count_ref)
        elif isinstance(child, RpfBinaryFile) and child.name.endswith('.yldb'):
            filepath = f"{current_path}/{child.name}" if current_path else child.name
            _extract_file(rpf_path, child, output_dir, filepath)
            count_ref[0] += 1

def _extract_file(rpf_path, entry, output_dir, filepath):
    """Extract a binary file entry from RPF."""
    offset = entry.file_offset * RBF_BLOCK_SIZE
    size = entry.file_size if entry.file_size > 0 else entry.uncompressed_size
    
    if entry.encrypted:
        print(f"  SKIP (encrypted): {filepath}")
        return
    
    with open(rpf_path, 'rb') as f:
        f.seek(offset)
        data = f.read(size)
    
    out_path = os.path.join(output_dir, filepath.replace('/', '\\'))
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, 'wb') as f:
        f.write(data)
    print(f"  EXTRACTED: {filepath} ({size} bytes)")

# Main
if __name__ == '__main__':
    game = r'D:\JUEGOS\PC\Steam\SteamLibrary\steamapps\common\Red Dead Redemption 2'
    output = os.path.join(game, 'lml', 'Dual Subtitles Complete')
    
    # RPFs to scan for yldb files
    rpfs = [
        'data_0.rpf',
        'update_2.rpf', 
        'update_3.rpf',
        'levels_0.rpf',
        'levels_1.rpf',
    ]
    
    os.makedirs(output, exist_ok=True)
    total = 0
    
    for rpf_name in rpfs:
        rpf_path = os.path.join(game, rpf_name)
        if not os.path.exists(rpf_path):
            print(f"SKIP {rpf_name}: not found")
            continue
        
        print(f"\nProcessing {rpf_name} ({os.path.getsize(rpf_path)//1024//1024} MB)...")
        root, err = read_rpf(rpf_path)
        if err:
            print(f"  ERROR: {err}")
            continue
        
        # Count yldb files
        yldb_files = []
        def find_yldb(dir_entry, path=""):
            for child in dir_entry.children:
                subpath = f"{path}/{child.name}" if path else child.name
                if isinstance(child, RpfDirectory):
                    find_yldb(child, subpath)
                elif isinstance(child, RpfBinaryFile) and child.name.endswith('.yldb'):
                    yldb_files.append((child, subpath))
        
        find_yldb(root)
        print(f"  Found {len(yldb_files)} .yldb files")
        
        for entry, filepath in yldb_files:
            offset = entry.file_offset * RBF_BLOCK_SIZE
            size = entry.file_size if entry.file_size > 0 else entry.uncompressed_size
            
            if entry.encrypted:
                print(f"  SKIP (encrypted): {filepath}")
                continue
            
            with open(rpf_path, 'rb') as f:
                f.seek(offset)
                data = f.read(size)
            
            out_path = os.path.join(output, f"{rpf_name.replace('.rpf','')}_{filepath.replace('/', '_')}")
            with open(out_path, 'wb') as f:
                f.write(data)
            total += 1
        
        print(f"  Extracted: {len(yldb_files)} files")
    
    print(f"\nTotal extracted: {total} yldb files")
