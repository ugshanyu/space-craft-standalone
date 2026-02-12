FROM node:20-slim

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install all dependencies (production + dev for build)
RUN npm install

# Copy source code
COPY . .

# Build Next.js app in production mode
ENV NODE_ENV=production
RUN npm run build

# Remove dev dependencies
RUN npm prune --production

# Railway uses PORT env var
ENV PORT=8080
EXPOSE 8080

# Start the custom server (production mode)
CMD ["node", "server.js"]
