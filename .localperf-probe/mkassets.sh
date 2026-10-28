#!/bin/bash
# Generates the synthetic media for f3/f4 (deterministic ffmpeg sources). Run where ffmpeg lives.
set -euo pipefail
PATH="$PATH:/c/ProgramData/chocolatey/bin"
F="$(cd "$(dirname "$0")" && pwd)/fixtures"
[ -f "$F/f3-4k-video-60s/assets/bg.mp4" ] || ffmpeg -nostdin -v error -f lavfi -i "testsrc2=size=3840x2160:rate=30:duration=60" -c:v libx264 -preset veryfast -crf 23 -pix_fmt yuv420p -g 60 "$F/f3-4k-video-60s/assets/bg.mp4"
[ -f "$F/f3-4k-video-60s/assets/pip.mp4" ] || ffmpeg -nostdin -v error -f lavfi -i "mandelbrot=size=1280x720:rate=30" -t 50 -c:v libx264 -preset veryfast -crf 23 -pix_fmt yuv420p -g 60 "$F/f3-4k-video-60s/assets/pip.mp4"
[ -f "$F/f4-1080p-audio-300s/assets/music.m4a" ] || ffmpeg -nostdin -v error -f lavfi -i "sine=frequency=220:duration=300" -f lavfi -i "anoisesrc=color=pink:amplitude=0.08:duration=300:seed=7" -filter_complex "[0][1]amix=inputs=2:normalize=0,volume=0.5" -ac 2 -ar 48000 -c:a aac -b:a 192k "$F/f4-1080p-audio-300s/assets/music.m4a"
ls -la "$F"/*/assets
