#!/bin/sh
# Wi-Fi router survey for one room (ADR-0030):  sh tools/wifi-survey/survey.sh "Classroom 8" [CAMPUS]
# Builds the small macOS scanner on first use, scans, saves scans/<room>.tsv and prints
# the strongest routers; with a second argument, only networks whose name starts with it
# (the college's Wi-Fi). Allow Location the first time macOS asks.
set -e
cd "$(dirname "$0")"
ROOM="${1:?Usage: survey.sh \"Room name\"}"
APP=build/ArgusWiFiScan.app
if [ ! -x "$APP/Contents/MacOS/ArgusWiFiScan" ]; then
  mkdir -p "$APP/Contents/MacOS"
  cp Info.plist "$APP/Contents/Info.plist"
  swiftc -O main.swift -o "$APP/Contents/MacOS/ArgusWiFiScan"
  codesign -s - --force "$APP" >/dev/null 2>&1
fi
rm -f build/wifi-scan.tsv
open "$APP"
i=0; while [ ! -s build/wifi-scan.tsv ] && [ $i -lt 60 ]; do sleep 2; i=$((i+1)); done
mkdir -p scans
cp build/wifi-scan.tsv "scans/$ROOM.tsv"
python3 - "scans/$ROOM.tsv" "${2:-}" <<'PY'
import sys
best = {}
for line in open(sys.argv[1]):
    if line.startswith('# connected'):
        p = line.rstrip().split('\t'); print('connected to', p[1], ':'.join(p[2].split(':')[:5]))
    if line.startswith('#'): continue
    p = line.rstrip('\n').split('\t')
    if len(p) < 3 or not p[0].upper().startswith(sys.argv[2].upper()): continue
    rid = ':'.join(p[1].lower().split(':')[:5]); best[rid] = max(best.get(rid, -200), int(p[2].split()[0]))
for rid, v in sorted(best.items(), key=lambda x: -x[1])[:6]:
    print(f'  {rid}  {v} dBm')
print('routers seen:', len(best))
PY
