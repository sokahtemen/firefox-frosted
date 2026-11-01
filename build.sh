#!/usr/bin/env bash
#
# build.sh - build Firefox with compositor background blur (ext-background-effect-v1)
#
# Usage:   ./build.sh            build the package only
#          ./build.sh --install  build, then install it with pacman (replaces "firefox")
#
# Env overrides:
#   FROSTED_JOBS=N   parallel compile jobs (default: one per 4 GB RAM, at
#                    most all cores). Lower it if the build gets OOM-killed.
#
# Output: pkg/firefox-frosted-<ver>-x86_64.pkg.tar.zst
# Log:    build-<date>.log

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG="$HERE/pkg"
LOG="$HERE/build-$(date +%Y%m%d-%H%M).log"
INSTALL=0
[ "${1:-}" = "--install" ] && INSTALL=1

log() { printf '\033[0;32m==>\033[0m %s\n' "$*"; }
die() { printf '\033[0;31mError:\033[0m %s\n' "$*" >&2; exit 1; }

command -v makepkg >/dev/null || die "makepkg not found (install base-devel)"

free_gb=$(df --output=avail -BG "$PKG" | tail -1 | tr -dc '0-9')
[ "$free_gb" -ge 35 ] || die "only ${free_gb} GB free in $PKG, need about 35 GB"

# Firefox peaks at ~4-5 GB per job (big Rust crates + C++ units), so allow one job per 4 GB of RAM.
mem_gb=$(free -g | awk '/^Mem:/{print $2}')
if [ -z "${FROSTED_JOBS:-}" ]; then
    jobs=$(( mem_gb / 4 ))
    [ "$jobs" -ge 2 ] || jobs=2
    [ "$jobs" -le "$(nproc)" ] || jobs=$(nproc)
    export FROSTED_JOBS=$jobs
    log "${mem_gb} GB RAM: using $FROSTED_JOBS jobs (override with FROSTED_JOBS=N)"
fi

log "Importing the Mozilla release signing key"
gpg --import "$PKG"/keys/pgp/*.asc 2>&1 | grep -v '^gpg: key .*not changed$' || true

cd "$PKG"
rm -rf src pkg

log "Building - this takes about an hour. Full log: $LOG"
log "makepkg will ask for your password to install missing build dependencies."
start=$(date +%s)
# -s installs makedepends, -f overwrites an old package file, -c cleans the build tree on success.
makepkg -sfc 2>&1 | tee "$LOG"
mins=$(( ($(date +%s) - start) / 60 ))

pkgfile=$(ls -t "$PKG"/firefox-frosted-*.pkg.tar.zst 2>/dev/null | head -1)
[ -n "$pkgfile" ] || die "no package produced, see $LOG"
log "Built $(basename "$pkgfile") in ${mins} minutes"

if [ "$INSTALL" = 1 ]; then
    log "Installing (replaces the repo firefox package)"
    sudo pacman -U "$pkgfile"
else
    cat <<EOF

Install it with:
    sudo pacman -U $pkgfile

It replaces the repo "firefox" package and keeps your profile. To go back:
    sudo pacman -S firefox
EOF
fi

cat <<'EOF'

Then in about:config:
    widget.transparent-windows                          = true
    toolkit.legacyUserProfileCustomizations.stylesheets = true
    widget.wayland.background-blur.enabled              = true   (default)
    widget.wayland.background-blur.popups               = false  (true = blur menus too, corners may show)

and use a userChrome.css with translucent colors, e.g. chrome/userChrome.css (see README.md).
In COSMIC: Settings > Desktop > Appearance > Style > Frosted glass must be on.
EOF
