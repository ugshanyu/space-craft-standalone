FROM node:20-slim

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Copy the rest of the server code
COPY . .

# Railway provides the PORT environment variable
EXPOSE 8080

# Run the server (env-file is for local, Railway uses real env vars)
CMD ["node", "server.js"]
