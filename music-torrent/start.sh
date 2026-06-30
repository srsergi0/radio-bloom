#!/bin/bash
# Start all services

echo "Starting Redis..."
redis-server --daemonize yes

echo "Starting RQ Worker..."
python worker.py &

echo "Starting MCP Server..."
python server_queue.py
