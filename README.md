# image-delivery-probe

Throwaway measurement for [visual-check](https://github.com/visual-check/visual-check): how fast a GitHub-hosted runner
gets a runnable Chromium headless shell (Chrome for Testing 158.0.8127.18) in a container, for several ways of
delivering it, and whether a slim image renders the same pixels as Playwright's image.

- `image/Dockerfile`: the slim image, Ubuntu 24.04 with apt pinned to a snapshot. `full` holds the headless shell,
  `base` doesn't and gets it bind-mounted at run time.
- `.github/workflows/prepare.yml`: builds a HeroUI Storybook, builds and pushes the images (gzip and zstd layers),
  records sizes and fonts, and saves cache entries.
- `.github/workflows/delivery.yml`: time to a runnable browser per delivery option, 8 shards per runner image.
- `.github/workflows/pixels.yml`: the same 300 stories captured in each image, hashes and pixel deltas compared.

`harness/` is copied from visual-check's research branch `research/raw-cdp-for-chromium` (MIT, see
[LICENSE](https://github.com/visual-check/visual-check/blob/main/LICENSE)). Packages and results are throwaway.
