ARG BASE_IMAGE=python:3.12-slim
FROM ${BASE_IMAGE}
ARG PIP_INDEX_URL=https://pypi.org/simple
ARG PIP_TRUSTED_HOST=
ARG APT_MIRROR=
ENV PIP_INDEX_URL=${PIP_INDEX_URL} PIP_TRUSTED_HOST=${PIP_TRUSTED_HOST}
# 사내망: APT_MIRROR 지정 시 데비안 미러를 Nexus apt 프록시로 교체
RUN if [ -n "${APT_MIRROR}" ]; then \
      sed -i "s|deb.debian.org|${APT_MIRROR}|g" /etc/apt/sources.list.d/debian.sources 2>/dev/null || \
      sed -i "s|deb.debian.org|${APT_MIRROR}|g" /etc/apt/sources.list; fi \
    && apt-get update && apt-get install -y --no-install-recommends gcc default-jdk-headless \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY services/test_agent/ .
EXPOSE 8600
CMD ["python", "app.py"]
