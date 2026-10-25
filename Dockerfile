# Tofu (2026-10-25): this file is Tofu's addition; it is not part of upstream Wiki.js.
# Tofu's container hosting builds the Dockerfile at the repository root and runs the image as a service. This one is
# upstream's dev/build/Dockerfile (unchanged, and still what upstream's own images are built from), except where a
# "Tofu:" line says why.

# ====================
# --- Build Assets ---
# ====================
FROM node:24-alpine AS assets

RUN apk add yarn g++ make cmake python3 --no-cache

WORKDIR /wiki

COPY ./client ./client
COPY ./dev ./dev
COPY ./patches ./patches
COPY ./package.json ./package.json
# Tofu: the lockfile too, so the image installs exactly the versions yarn.lock names (upstream's resolves them anew).
COPY ./yarn.lock ./yarn.lock
COPY ./.babelrc ./.babelrc
COPY ./.eslintignore ./.eslintignore
COPY ./.eslintrc.yml ./.eslintrc.yml

RUN yarn cache clean
RUN yarn --frozen-lockfile --non-interactive
RUN yarn build
RUN rm -rf /wiki/node_modules
RUN yarn --production --frozen-lockfile --non-interactive
RUN yarn patch-package

# ===============
# --- Release ---
# ===============
FROM node:24-alpine
LABEL maintainer="requarks.io"

RUN apk add bash curl git openssh gnupg sqlite --no-cache && \
    mkdir -p /wiki && \
    mkdir -p /logs && \
    mkdir -p /wiki/data/content && \
    chown -R node:node /wiki /logs

WORKDIR /wiki

COPY --chown=node:node --from=assets /wiki/assets ./assets
COPY --chown=node:node --from=assets /wiki/node_modules ./node_modules
COPY --chown=node:node ./server ./server
COPY --chown=node:node --from=assets /wiki/server/views ./server/views
# Tofu: Tofu's configuration (dev/tofu/config.yml): the port from PORT, PostgreSQL from DATABASE_URL, offline mode,
# and the English interface offline mode reads from data/sideload (dev/tofu/sideload/SOURCE.md says where it is from).
COPY --chown=node:node ./dev/tofu/config.yml ./config.yml
COPY --chown=node:node ./dev/tofu/sideload ./data/sideload
COPY --chown=node:node ./package.json ./package.json
COPY --chown=node:node ./LICENSE ./LICENSE

# Tofu: no `USER node` and no `VOLUME`. Tofu gives the container PORT=80 unless the app sets another, only root may
# listen on a port below 1024, so the server runs as root; and no disk outlives a restart on Tofu, so Wiki.js keeps
# everything in its PostgreSQL database (uploads included).

EXPOSE 3000

CMD ["node", "--no-deprecation", "server"]
