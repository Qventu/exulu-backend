#!/bin/zsh
# Re-encode every video referenced by a release page into _build/enc/<slug>__<name>.mp4
# 1080p max, libx264 CRF 27, no audio (pages play muted), +faststart.
set -u
cd "$(dirname "$0")/.."
mkdir -p _build/enc
: > _build/enc/jobs.txt
for d in 2026-*/; do
  slug="${d%/}"
  [ -f "$d/index.html" ] || continue
  { grep -o 'src="\./shorts/[^"]*\.mp4"' "$d/index.html" | sed 's/src=".\/shorts\///; s/"$//'; \
    grep -o 'data-short="[^"]*\.mp4"' "$d/index.html" | sed 's/data-short="//; s/"$//'; } | sort -u | while read -r name; do
    src="$d/shorts/$name"
    out="_build/enc/${slug}__${name}"
    if [ -f "$src" ]; then
      echo "$src|$out" >> _build/enc/jobs.txt
    else
      echo "MISSING: $src" >> _build/enc/missing.txt
    fi
  done
done
wc -l _build/enc/jobs.txt
cat _build/enc/jobs.txt | xargs -P 8 -I {} zsh -c '
  src="${0%%|*}"; out="${0##*|}"
  ffmpeg -y -v error -i "$src" -vf "scale='"'"'min(1920,iw)'"'"':-2" \
    -c:v libx264 -crf 27 -preset slow -pix_fmt yuv420p -movflags +faststart -an "$out" \
    && echo "OK $out" || echo "FAIL $src"
' {}
echo "=== done ==="
ls _build/enc/*.mp4 | wc -l
du -ch _build/enc/*.mp4 | tail -1
[ -f _build/enc/missing.txt ] && cat _build/enc/missing.txt
exit 0
