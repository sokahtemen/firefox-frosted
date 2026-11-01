# firefox-frosted

Firefox 158 packaged for Arch/CachyOS with a Wayland `ext-background-effect-v1`
patch, so the COSMIC compositor blurs what is behind translucent Firefox windows.

- `pkg/` - PKGBUILD and patches (`0002-wayland-ext-background-effect-blur.patch` is the blur patch)
- `proto/` - generated protocol bindings
- `build.sh` - builds the package (`./build.sh --install` also installs it). Needs the
  Firefox source tarball next to it; a full build takes ~1 hour and a lot of RAM/swap.
- `frosted-pages/` - companion extension that makes page backgrounds translucent per site
  (needs `browser.tabs.allow_transparent_browser=true`).
