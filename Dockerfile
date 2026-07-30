FROM ghcr.io/puppeteer/puppeteer:24.43.1

WORKDIR /home/pptruser
# Pin HOME so path resolution (Puppeteer's Chrome cache, ~/.js-recon rules cache, etc.)
# is consistent regardless of which OS user actually executes the process -- root
# (docker-entrypoint.sh, or any --entrypoint override that bypasses it) or pptruser.
ENV HOME=/home/pptruser

# selectively copy the source files
COPY ./package.json .
COPY ./package-lock.json .
COPY ./tsconfig.json .
COPY ./patches ./patches
COPY ./src ./src

USER root
ENV PUPPETEER_SKIP_DOWNLOAD=true
RUN apt-get update && apt-get install -y --no-install-recommends \
    unzip gosu \
    libnspr4 libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
    libxcomposite1 libxdamage1 libxrandr2 libgbm1 libxkbcommon0 \
    libasound2 libpangocairo-1.0-0 libxfixes3 libxi6 libxinerama1 \
    libxcursor1 libdrm2 && \
    rm -rf /var/lib/apt/lists/*
RUN npm ci
RUN npm run build

USER pptruser
RUN ./node_modules/.bin/puppeteer browsers install chrome && \
    for zip in /home/pptruser/.cache/puppeteer/chrome/*-chrome-linux64.zip; do \
        [ -f "$zip" ] || break; \
        version="${zip%-chrome-linux64.zip}"; version="${version##*/}"; \
        dest="/home/pptruser/.cache/puppeteer/chrome/linux-${version}"; \
        unzip -o "$zip" -d "${dest}/" && chmod +x "${dest}/chrome-linux64/chrome"; \
    done
RUN mkdir -p output

USER root
COPY ./docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

ENV IS_DOCKER=true
ENV NODE_OPTIONS="--max-http-header-size=99999999"
ENV JS_RECON_OUTPUT_OVERWRITE=true
ENTRYPOINT ["/docker-entrypoint.sh", "node", "build/index.js"]