FROM node:20-bullseye-slim

# Install fontconfig, base configs, and font packages
RUN apt-get update && apt-get install -y --no-install-recommends \
    fontconfig \
    libfontconfig1 \
    fonts-dejavu-core \
    fonts-noto \
    fonts-noto-cjk \
    fonts-noto-color-emoji \
    && fc-cache -f -v \
    && rm -rf /var/lib/apt/lists/*

# Explicitly tell Linux libraries where fonts.conf lives
ENV FONTCONFIG_PATH=/etc/fonts

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .
RUN npm run build

ENV PORT=8080
EXPOSE 8080

CMD ["node", "dist/server.cjs"]