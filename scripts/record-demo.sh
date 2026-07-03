#!/usr/bin/env bash
# Regenerates the landing-page terminal demo from the REAL CLI, so the demo
# can never drift from the product. Requires: vhs (brew install vhs), ffmpeg.
#
# Usage: npm run build && bash scripts/record-demo.sh
#
# Outputs:
#   apps/web/public/demo.webm        hero video (webm)
#   apps/web/public/demo.mp4         hero video (safari/fallback)
#   apps/web/public/demo-poster.png  poster frame shown before playback
#   docs/assets/demo.gif             README / social embed
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLI="$REPO_ROOT/packages/cli/dist/index.js"
[ -f "$CLI" ] || { echo "CLI not built — run: npm run build" >&2; exit 1; }
command -v vhs >/dev/null || { echo "vhs not installed — brew install vhs" >&2; exit 1; }
command -v ffmpeg >/dev/null || { echo "ffmpeg not installed" >&2; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# 1. Capture real first-run output (clean HOME -> labeled sample data, no
#    local keys or transcripts can leak into the recording).
mkdir -p "$WORK/home" "$WORK/cwd"
(cd "$WORK/cwd" && HOME="$WORK/home" FORCE_COLOR=1 node "$CLI" > "$WORK/demo.raw" 2>&1)
grep -q "DATA MODE" "$WORK/demo.raw" || { echo "captured output missing sample banner — aborting" >&2; exit 1; }

# The CLI emits some lines wider than the recording terminal; hard column
# wraps break mid-word on camera. Word-wrap at 100 visible columns, ANSI-aware.
python3 - "$WORK/demo.raw" > "$WORK/demo.ans" <<'EOF'
import re, sys

LIMIT, INDENT = 88, "       "
ansi = re.compile(r"\x1b\[[0-9;]*m")

def visible_len(s):
    return len(ansi.sub("", s))

for raw in open(sys.argv[1], encoding="utf-8"):
    line = raw.rstrip("\n")
    while visible_len(line) > LIMIT:
        # walk to the last space before the visible-column limit
        col = 0; i = 0; break_at = -1
        while i < len(line):
            m = ansi.match(line, i)
            if m:
                i = m.end(); continue
            if line[i] == " " and col <= LIMIT:
                break_at = i
            col += 1
            if col > LIMIT and break_at > 0:
                break
            i += 1
        if break_at <= 0:
            break
        print(line[:break_at])
        line = INDENT + line[break_at + 1 :]
    print(line)
EOF

# 2. Playback script: reveal the report at a readable pace (headline slow,
#    table fast) instead of dumping 70 lines in one frame.
cat > "$WORK/play.sh" <<'EOF'
#!/usr/bin/env bash
sleep 0.9
n=0
while IFS= read -r line; do
  n=$((n+1))
  printf '%s\n' "$line"
  if   [ "$n" -lt 10 ]; then sleep 0.30
  elif [ "$n" -lt 50 ]; then sleep 0.20
  else sleep 0.08; fi
done < "$(dirname "$0")/demo.ans"
sleep 3
EOF
chmod +x "$WORK/play.sh"

# 3. VHS tape. The hidden shim makes `npx ai-spend-agent` replay the captured
#    real output — what viewers see typed is exactly what users will run.
cat > "$WORK/demo.tape" <<EOF
Output "$WORK/demo.webm"
Output "$WORK/demo.mp4"
Set Shell bash
Set FontSize 30
Set Width 2000
Set Height 1400
Set Padding 48
Set TypingSpeed 65ms
Set Theme { "name": "ai-spend-agent", "background": "#060609", "foreground": "#c9ccd3", "cursor": "#4ade80", "black": "#1e2127", "red": "#f87171", "green": "#4ade80", "yellow": "#facc15", "blue": "#60a5fa", "magenta": "#c084fc", "cyan": "#22d3ee", "white": "#f4f4f6", "brightBlack": "#565b66", "brightRed": "#f87171", "brightGreen": "#4ade80", "brightYellow": "#facc15", "brightBlue": "#60a5fa", "brightMagenta": "#c084fc", "brightCyan": "#22d3ee", "brightWhite": "#f4f4f6" }
Hide
Type "npx() { bash '$WORK/play.sh'; }; clear"
Enter
Show
Sleep 800ms
Type "npx ai-spend-agent"
Sleep 600ms
Enter
Sleep 22s
EOF
vhs "$WORK/demo.tape"

# 4. Poster: the headline-number moment (~9.5s in), so the pre-play frame
#    already shows a dollar figure instead of an empty prompt.
ffmpeg -y -loglevel error -ss 9.5 -i "$WORK/demo.mp4" -frames:v 1 "$WORK/demo-poster.png"

# 5. README/social gif, downscaled from the mp4 to keep the repo light.
ffmpeg -y -loglevel error -i "$WORK/demo.mp4" \
  -vf "fps=10,scale=1000:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer" \
  "$WORK/demo.gif"

mkdir -p "$REPO_ROOT/apps/web/public" "$REPO_ROOT/docs/assets"
cp "$WORK/demo.webm" "$WORK/demo.mp4" "$WORK/demo-poster.png" "$REPO_ROOT/apps/web/public/"
cp "$WORK/demo.gif" "$REPO_ROOT/docs/assets/demo.gif"
ls -lh "$REPO_ROOT/apps/web/public/demo."* "$REPO_ROOT/docs/assets/demo.gif"
