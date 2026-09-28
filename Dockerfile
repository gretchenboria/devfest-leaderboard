FROM node:20-alpine

WORKDIR /app


# Copy package descriptors
COPY package*.json ./

# Install production dependencies
RUN npm ci --omit=dev

# Copy application source code
COPY . .

# Cloud Run defaults
ENV PORT=8080
ENV NODE_ENV=production
ENV GCS_BUCKET=devfest2026-leaderboard-gde

EXPOSE 8080

CMD ["node", "server.js"]
