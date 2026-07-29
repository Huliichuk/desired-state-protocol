# DSP reference runtime.
#
# Node 22+ is required: the runtime uses the built-in `node:sqlite`, so there is no
# native module to compile and no build toolchain in the final image.

# ---------- build ----------
FROM node:22-slim AS build

WORKDIR /app
ENV CI=true

RUN corepack enable

# Copy only what pnpm needs to resolve the workspace, so a source-only change does
# not invalidate the dependency layer.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/protocol/package.json            packages/protocol/
COPY packages/secret-store/package.json        packages/secret-store/
COPY packages/provider-sdk/package.json        packages/provider-sdk/
COPY packages/policy-engine/package.json       packages/policy-engine/
COPY packages/plan-engine/package.json         packages/plan-engine/
COPY packages/execution-engine/package.json    packages/execution-engine/
COPY packages/verification-engine/package.json packages/verification-engine/
COPY packages/audit/package.json               packages/audit/
COPY packages/provider-mock/package.json       packages/provider-mock/
COPY packages/core/package.json                packages/core/
COPY apps/server/package.json                  apps/server/
COPY apps/cli/package.json                     apps/cli/

RUN pnpm install --frozen-lockfile

COPY tsconfig.base.json tsconfig.json ./
COPY packages/ packages/
COPY apps/ apps/
COPY schemas/ schemas/

RUN pnpm build

# Drop dev dependencies from the workspace that ships.
RUN pnpm install --frozen-lockfile --prod

# ---------- runtime ----------
FROM node:22-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production \
    DSP_HOST=0.0.0.0 \
    DSP_PORT=4040 \
    DSP_DATABASE=/data/runtime.sqlite \
    DSP_MOCK_DATABASE=/data/mock.sqlite

# pnpm workspaces are symlinked, so the built tree and its node_modules have to
# travel together for `@dsp/*` to resolve at runtime.
COPY --from=build /app/node_modules          ./node_modules
COPY --from=build /app/packages              ./packages
COPY --from=build /app/apps                  ./apps
COPY --from=build /app/schemas               ./schemas
COPY --from=build /app/package.json          ./package.json
COPY --from=build /app/pnpm-workspace.yaml   ./pnpm-workspace.yaml

# The image ships no token on purpose: an unset DSP_AUTH_TOKEN makes the server
# generate one per process and print it, which is safe but useless in a container.
# Set DSP_AUTH_TOKEN explicitly when you run it.
RUN mkdir -p /data && chown -R node:node /data /app
USER node

VOLUME ["/data"]
EXPOSE 4040

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.DSP_PORT||4040)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["node", "apps/server/dist/main.js"]
