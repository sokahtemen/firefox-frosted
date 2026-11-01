# firefox-frosted

Firefox 158 packaged for Arch/CachyOS with a Wayland `ext-background-effect-v1`
patch, so the COSMIC compositor blurs what is behind translucent Firefox windows.

- `pkg/` - PKGBUILD and patches (`0002-wayland-ext-background-effect-blur.patch` is the blur patch)
- `proto/` - generated protocol bindings
- `build.sh` - builds the package (`./build.sh --install` also installs it). makepkg
  downloads the Firefox source (~800 MB) the first time; a full build takes ~1 hour and a
  lot of RAM/swap.
- `frosted-pages/` - companion extension that makes page backgrounds translucent per site
  (needs `browser.tabs.allow_transparent_browser=true`). It is unsigned, which Firefox
  accepts in the application scope, so install it there for every profile:
  `cd frosted-pages && rm -f ../frosted-pages.xpi && zip -r -X ../frosted-pages.xpi . && sudo install -m644 ../frosted-pages.xpi /usr/lib/firefox/browser/extensions/frosted-pages@nemeth.local.xpi`.
  Profiles load it with `extensions.autoDisableScopes=11` and `extensions.startupScanScopes=4`.
- `chrome/userChrome.css` - COSMIC-styled browser UI (translucent tokens, two-row header with
  menu + nav bar). Symlink it into the profile:
  `ln -s "$PWD/chrome/userChrome.css" ~/.config/mozilla/firefox/<profile>/chrome/userChrome.css`
  and set `toolkit.legacyUserProfileCustomizations.stylesheets=true`.

## AI-generated

This project is vibecoded: all of the code, patches and docs were written by
[Claude Code](https://claude.com/claude-code) using **Claude Opus 5.5**
(`claude-opus-5-5`) at **medium effort**, with a cleanup pass at **max effort**. A human gave the directions and did
the testing, but did not review the code line by line.

## License

[MPL-2.0](LICENSE), the same as Firefox, since the patches modify Firefox code.
The packaging files in `pkg/` come from the Arch Linux `firefox` package
(PKGBUILD 0BSD, other files MPL-2.0).
