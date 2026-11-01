FROM node:24-slim
# ffprobe is used to enforce the 30-second video limit on the server.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
# Build the polling unit database here (the builder has plenty of memory), not on the server.
RUN DB_PATH=/app/seed/ivote.sqlite node --max-old-space-size=3072 scripts/build-db.js
ENV NODE_ENV=production PORT=8080 DB_PATH=/data/ivote.sqlite UPLOADS_DIR=/data/uploads
EXPOSE 8080
# First boot copies the database onto the volume; later boots reuse it (reports live there).
CMD ["sh", "-c", "[ -f \"$DB_PATH\" ] || cp /app/seed/ivote.sqlite \"$DB_PATH\"; node server.js"]
