#!/usr/bin/env bash
# Regenerates the landing-page terminal demo from the real CLI. The checked-in
# media are release snapshots, not self-updating assets: rerun this script after
# any user-visible terminal-copy or sample-output change.
# Requires: vhs (brew install vhs), ffmpeg.
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

AIBILL_DEMO_TMP="$(mktemp -d)"
trap 'rm -rf "$AIBILL_DEMO_TMP"' EXIT

# 1. Capture the CLI's explicit deterministic full sample. `--sample`
#    intentionally skips local plan and credential discovery, while `--full`
#    preserves the complete interactive terminal walkthrough used on the site.
mkdir -p "$AIBILL_DEMO_TMP/cwd"
(cd "$AIBILL_DEMO_TMP/cwd" && env -u NO_COLOR FORCE_COLOR=1 node "$CLI" --sample --full --path "$AIBILL_DEMO_TMP/cwd" > "$AIBILL_DEMO_TMP/demo.raw" 2>&1)
grep -q "DATA MODE: demo sample" "$AIBILL_DEMO_TMP/demo.raw" || { echo "captured output missing sample banner — aborting" >&2; exit 1; }
grep -q "ILLUSTRATIVE COST / VALUE EVIDENCE" "$AIBILL_DEMO_TMP/demo.raw" || { echo "captured output missing the mixed-basis sample label — aborting" >&2; exit 1; }
grep -q "NON-EXECUTABLE DEMO" "$AIBILL_DEMO_TMP/demo.raw" || { echo "captured output missing the sample Apply safety boundary — aborting" >&2; exit 1; }

# The CLI emits some lines wider than the recording terminal; hard column
# wraps break mid-word on camera. Word-wrap at 100 visible columns, ANSI-aware.
python3 - "$AIBILL_DEMO_TMP/demo.raw" > "$AIBILL_DEMO_TMP/demo.ans" <<'EOF'
import re, sys

LIMIT, INDENT = 100, "       "
ansi = re.compile(r"\x1b\[[0-9;]*m")

def visible_len(s):
    return len(ansi.sub("", s))

for raw in open(sys.argv[1], encoding="utf-8"):
    line = raw.rstrip("\n")
    while visible_len(line) > LIMIT:
        # walk to the last space before the visible-column limit
        col = 0; i = 0; break_at = -1; hard_break_at = -1
        while i < len(line):
            m = ansi.match(line, i)
            if m:
                i = m.end(); continue
            if line[i] == " " and col <= LIMIT:
                break_at = i
            col += 1
            if col == LIMIT:
                hard_break_at = i + 1
            if col > LIMIT and break_at > 0:
                break
            i += 1
        # A deeply indented long token can leave the only candidate break in
        # the continuation indent. Reusing that point makes no progress and
        # loops forever, so hard-wrap the visible token instead.
        if break_at <= len(INDENT):
            break_at = hard_break_at
        if break_at <= 0:
            break
        print(line[:break_at])
        remainder = line[break_at:]
        line = INDENT + remainder.lstrip(" ")
    print(line)
EOF

# 2. Playback script: reveal the report at a readable pace (headline slow,
#    table fast) instead of dumping 70 lines in one frame.
cat > "$AIBILL_DEMO_TMP/play.sh" <<'EOF'
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
chmod +x "$AIBILL_DEMO_TMP/play.sh"

# 3. VHS tape. The hidden shim replays the captured real output; the command
#    viewers see is the exact explicit sample/full command that produced it.
cat > "$AIBILL_DEMO_TMP/demo.tape" <<EOF
Output "$AIBILL_DEMO_TMP/demo.webm"
Output "$AIBILL_DEMO_TMP/demo.mp4"
Set Shell bash
Set FontSize 29
Set Width 2000
Set Height 1400
Set Padding 48
Set TypingSpeed 65ms
Set Theme { "name": "aibill", "background": "#060609", "foreground": "#c9ccd3", "cursor": "#4ade80", "black": "#1e2127", "red": "#f87171", "green": "#4ade80", "yellow": "#facc15", "blue": "#60a5fa", "magenta": "#c084fc", "cyan": "#22d3ee", "white": "#f4f4f6", "brightBlack": "#565b66", "brightRed": "#f87171", "brightGreen": "#4ade80", "brightYellow": "#facc15", "brightBlue": "#60a5fa", "brightMagenta": "#c084fc", "brightCyan": "#22d3ee", "brightWhite": "#f4f4f6" }
Hide
Type "npx() { bash '$AIBILL_DEMO_TMP/play.sh'; }; clear"
Enter
Show
Sleep 800ms
Type "npx aibill --sample --full"
Sleep 600ms
Enter
Sleep 22s
EOF
vhs "$AIBILL_DEMO_TMP/demo.tape"

# 4. Poster: the headline-number moment (~9.5s in), so the pre-play frame
#    already shows a dollar figure instead of an empty prompt.
ffmpeg -y -loglevel error -ss 9.5 -i "$AIBILL_DEMO_TMP/demo.mp4" -frames:v 1 "$AIBILL_DEMO_TMP/demo-poster.png"

# 5. README/social gif, downscaled from the mp4 to keep the repo light.
ffmpeg -y -loglevel error -i "$AIBILL_DEMO_TMP/demo.mp4" \
  -vf "fps=10,scale=1000:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer" \
  "$AIBILL_DEMO_TMP/demo.gif"

mkdir -p "$REPO_ROOT/apps/web/public" "$REPO_ROOT/docs/assets"
cp "$AIBILL_DEMO_TMP/demo.webm" "$AIBILL_DEMO_TMP/demo.mp4" "$AIBILL_DEMO_TMP/demo-poster.png" "$REPO_ROOT/apps/web/public/"
cp "$AIBILL_DEMO_TMP/demo.gif" "$REPO_ROOT/docs/assets/demo.gif"
ls -lh "$REPO_ROOT/apps/web/public/demo."* "$REPO_ROOT/docs/assets/demo.gif"
