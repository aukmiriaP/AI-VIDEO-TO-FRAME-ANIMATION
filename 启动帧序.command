#!/bin/bash
set -e
PROJECT_DIR="$(dirname "$0")"
export FRAME_STUDIO_ROOT="$PROJECT_DIR"
exec "$PROJECT_DIR/.venv/bin/python" "$PROJECT_DIR/launch.py"
