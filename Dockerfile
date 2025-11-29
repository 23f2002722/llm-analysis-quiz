# Use official Node image
FROM node:20-slim

# Install needed apt packages for Playwright browsers
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y \
    ca-certificates \
    wget \
    libnss3 \
    libnspr4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libxkbcommon0 \
    libasound2 \
    libatspi2.0-0 \
    fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

# Create app dir
WORKDIR /app
COPY package.json package-lock.json* ./ 

# Install npm deps (playwright included)
RUN npm ci

# Install playwright browsers and dependencies
RUN npx playwright install --with-deps

# copy source
COPY . .

# Create non-root user (Hugging Face recommends non-root)
RUN useradd -m appuser && chown -R appuser:appuser /app
USER appuser

EXPOSE 7860 3000

ENV PORT=3000

CMD ["node", "server.js"]
