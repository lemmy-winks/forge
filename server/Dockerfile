# Stage 1: build the React PWA (Node exists only here, never in the runtime image)
FROM node:24-alpine AS webbuild
WORKDIR /w
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ .
RUN npm run build

# Stage 2: Python runtime serving API + built frontend
FROM python:3.12-slim

WORKDIR /srv/forge
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1

COPY server/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY server/app ./app
COPY --from=webbuild /w/dist ./static

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s \
  CMD python -c "import urllib.request;urllib.request.urlopen('http://localhost:8000/healthz')" || exit 1

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips", "*"]
