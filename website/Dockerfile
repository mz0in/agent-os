# Build the Astro site. The shared docs theme (@rivet-dev/docs-theme) is fetched
# from GitHub during install, so this builds from the self-contained website/
# directory — the build context is website/ (set the deploy root directory to
# website/), with no monorepo context required.
FROM node:22-alpine AS build
WORKDIR /app
# git is required for pnpm to resolve the github: docs-theme dependency.
RUN apk add --no-cache git && npm install -g pnpm@9

# Install dependencies first so this layer caches across source-only changes.
COPY package.json ./
RUN pnpm install

# Copy the rest of the site and build (see .dockerignore for exclusions).
COPY . .
RUN pnpm build

# Serve the static output.
FROM caddy:alpine
COPY --from=build /app/dist /srv
RUN cat > /etc/caddy/Caddyfile <<'EOF'
:80 {
	root * /srv
	file_server
	try_files {path} /index.html
}
EOF
EXPOSE 80
