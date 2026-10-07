"""Docker health check for both modes: does the app answer on its port?"""
import os
import ssl
import sys
import urllib.request

if os.environ.get("MODE", "lan").strip().lower() == "public":
    urls = ["http://127.0.0.1:" + (os.environ.get("PORT") or "8080") + "/robots.txt"]
else:
    # With TLS_CERT=auto only the app knows whether it found a certificate,
    # so try HTTPS first and plain HTTP second.
    port = os.environ.get("PORT")
    urls = [f"https://127.0.0.1:{port or 443}/api/help", f"http://127.0.0.1:{port or 80}/api/help"]

errors = []
for url in urls:
    try:
        urllib.request.urlopen(url, timeout=4, context=ssl._create_unverified_context())
        sys.exit(0)
    except Exception as error:      # any answer but 2xx/3xx means unhealthy
        errors.append(f"{url}: {error}")
print("unhealthy: " + "; ".join(errors))
sys.exit(1)
