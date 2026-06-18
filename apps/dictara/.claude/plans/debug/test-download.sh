#!/bin/bash

# Test script to check when GitHub increments download counter
# Tests with v0.1.26-rc.1 release asset

URL="https://github.com/vitalii-zinchenko/dictara/releases/download/v0.1.26-rc.1/Dictara_aarch64.app.tar.gz"
TEMP_DIR=$(mktemp -d)

echo "==================================="
echo "GitHub Download Counter Test"
echo "==================================="
echo "Test file: Dictara_aarch64.app.tar.gz"
echo "Release: v0.1.26-rc.1"
echo "Temp directory: $TEMP_DIR"
echo ""

# Function to download with progress
download_full() {
    local num=$1
    echo "[Full Download $num/5] Starting complete download..."
    curl -L -o "$TEMP_DIR/full_$num.tar.gz" \
        --progress-bar \
        "$URL"
    echo "[Full Download $num/5] ✓ Complete ($(du -h "$TEMP_DIR/full_$num.tar.gz" | cut -f1))"
    echo ""
}

# Function to download first 1MB then cancel
download_partial() {
    local num=$1
    echo "[Partial Download $num/5] Starting download (will abort after 1MB)..."

    # Use --max-filesize to abort after 1MB
    # Alternative: use timeout with --limit-rate
    timeout 2s curl -L \
        --progress-bar \
        --max-filesize 1048576 \
        -o "$TEMP_DIR/partial_$num.tar.gz" \
        "$URL" 2>&1 || true

    local size=$(du -h "$TEMP_DIR/partial_$num.tar.gz" 2>/dev/null | cut -f1 || echo "0")
    echo "[Partial Download $num/5] ✗ Aborted (downloaded: $size)"
    echo ""
}

echo "==================================="
echo "PHASE 1: Full Downloads (5x)"
echo "==================================="
echo ""

for i in {1..5}; do
    download_full $i
    sleep 1
done

echo "==================================="
echo "PHASE 2: Partial Downloads (5x)"
echo "==================================="
echo ""

for i in {1..5}; do
    download_partial $i
    sleep 1
done

echo "==================================="
echo "Test Complete!"
echo "==================================="
echo ""
echo "Downloaded files:"
ls -lh "$TEMP_DIR"
echo ""
echo "Total disk usage:"
du -sh "$TEMP_DIR"
echo ""
echo "Cleaning up..."
rm -rf "$TEMP_DIR"
echo "Done!"
echo ""
echo "==================================="
echo "Next Steps:"
echo "==================================="
echo "1. Wait 2-5 minutes for GitHub stats to update"
echo "2. Check new download count with:"
echo ""
echo "   gh api repos/vitalii-zinchenko/dictara/releases/tags/v0.1.26-rc.1 \\"
echo "     --jq '.assets[] | select(.name == \"Dictara_aarch64.app.tar.gz\") | .download_count'"
echo ""
echo "3. Compare to baseline: 1"
echo ""
echo "If count increased by:"
echo "  - 10 = GitHub counts on request start"
echo "  - 5  = GitHub counts on completion only"
echo "  - 0  = Stats not updated yet (wait longer)"
echo "==================================="
