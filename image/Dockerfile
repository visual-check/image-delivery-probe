# Slim image for Chromium's headless shell. Targets:
#   base: Ubuntu 24.04, the shared libraries headless shell links, fontconfig and Playwright's font set. No browser:
#         the Chrome for Testing (CfT) zip is unzipped on the host and bind-mounted at /opt/chrome-headless-shell.
#   full: base plus the CfT zip unzipped as-is at /opt/chrome-headless-shell.
# Build context: this folder. Named context `cft`: a folder holding the CfT zip (CFT_ZIP).
ARG UBUNTU=ubuntu:24.04@sha256:fe81560990fae86dc4743202b2cb4d3df98d0bcf949173cecef15ce1127ef852

FROM ${UBUNTU} AS base
ARG SNAPSHOT=
ARG APT_OPTS=
ARG CA_FIRST=0
ARG CHROMIUM=158.0.8127.18
ARG TARGETARCH
ENV LANG=C.UTF-8 LC_ALL=C.UTF-8
RUN --mount=type=bind,source=apt-install.sh,target=/tmp/apt-install.sh \
    SNAPSHOT="$SNAPSHOT" APT_OPTS="$APT_OPTS" CA_FIRST="$CA_FIRST" DEBIAN_FRONTEND=noninteractive sh /tmp/apt-install.sh \
      libglib2.0-0t64 libnss3 libnspr4 libatk1.0-0t64 libatk-bridge2.0-0t64 libatspi2.0-0t64 libdbus-1-3 libx11-6 \
      libxcomposite1 libxdamage1 libxext6 libxfixes3 libxrandr2 libxcb1 libxkbcommon0 libgbm1 libexpat1 libasound2t64 \
      fontconfig fontconfig-config fonts-liberation fonts-noto-color-emoji fonts-wqy-zenhei fonts-ipafont-gothic \
      fonts-tlwg-loma-otf fonts-freefont-ttf fonts-unifont \
 && mkdir -p /etc/visual-check \
 && printf '{"chromium":"%s","arch":"%s"}\n' "$CHROMIUM" "$TARGETARCH" > /etc/visual-check/image.json

FROM ${UBUNTU} AS unpack
ARG CFT_ZIP
RUN apt-get -o Acquire::Retries=5 -o Acquire::ForceIPv4=true update \
 && apt-get -o Acquire::Retries=5 -o Acquire::ForceIPv4=true install -y --no-install-recommends unzip
RUN --mount=type=bind,from=cft,target=/cft unzip -q "/cft/$CFT_ZIP" -d /opt/chrome-headless-shell

FROM base AS full
COPY --from=unpack /opt/chrome-headless-shell /opt/chrome-headless-shell
