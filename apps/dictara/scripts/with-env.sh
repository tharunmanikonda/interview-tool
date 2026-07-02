#!/bin/bash
# Load environment variables from .env and execute command
# Usage: ./scripts/with-env.sh <command>

set -e

# Load .env file (skip comments and empty lines)
if [ -f .env ]; then
  export $(grep -v '^#' .env | grep -v '^$' | xargs)
fi

# Execute the command passed as arguments
exec "$@"
