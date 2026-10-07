# Drop — one image for both containers: MODE=lan (Drop itself) and
# MODE=public (share links only). Built and published by
# .github/workflows/image.yml; compose.yaml only pulls it.
FROM python:3.13-slim

COPY requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt && rm /tmp/requirements.txt

ENV PYTHONUTF8=1 \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

WORKDIR /app
COPY main.py healthcheck.py entrypoint.sh LICENSE ./
COPY static/ static/
COPY lang/ lang/
COPY help/ help/
RUN chmod -R a+rX /app && chmod 755 /app/entrypoint.sh

EXPOSE 80 443 8080

# Healthy as soon as the app answers. drop-share waits for drop to be healthy.
HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=3m --start-interval=2s \
  CMD ["python", "/app/healthcheck.py"]

# main.py picks port and TLS from the environment — one command for every mode.
ENTRYPOINT ["/app/entrypoint.sh"]
