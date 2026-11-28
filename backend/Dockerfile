FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    ALLOW_LOCAL_SANDBOX=true \
    DOCKER_MULTI_RUNTIME=true

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    xz-utils \
    g++ \
    openjdk-21-jdk-headless \
    && rm -rf /var/lib/apt/lists/*

# Install Go 1.23.6 and Node.js 24 LTS cleanly across amd64/arm64
ARG NODE_VERSION=24.13.1
ARG GO_VERSION=1.23.6
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      amd64) node_arch="x64"; go_arch="amd64" ;; \
      arm64) node_arch="arm64"; go_arch="arm64" ;; \
      *) echo "Unsupported arch: $arch" && exit 1 ;; \
    esac; \
    curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${node_arch}.tar.xz" -o /tmp/node.tar.xz; \
    tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1; \
    rm -f /tmp/node.tar.xz; \
    curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-${go_arch}.tar.gz" -o /tmp/go.tar.gz; \
    tar -xzf /tmp/go.tar.gz -C /usr/local; \
    rm -f /tmp/go.tar.gz

ENV PATH="/usr/local/go/bin:${PATH}"

RUN python3 --version && java -version && javac -version && g++ --version && node --version && go version

RUN useradd --create-home --shell /bin/bash appuser

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY --chown=appuser:appuser . .

# Keep static problem catalogs read-only while letting appuser write language_variants.db
RUN chown -R appuser:appuser /app \
    && if [ -f /app/problems.db ]; then chown root:root /app/problems.db && chmod 444 /app/problems.db; fi \
    && if [ -f /app/interview_problems.db ]; then chown root:root /app/interview_problems.db && chmod 444 /app/interview_problems.db; fi

USER appuser

CMD exec uvicorn main:app --host 0.0.0.0 --port ${PORT:-8080} --forwarded-allow-ips='*'
