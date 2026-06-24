# 사내망: --build-arg 로 Nexus Pro 프록시를 지정해 빌드
#   docker build --build-arg BASE_IMAGE=nexus.company.com:5000/python:3.12-slim \
#                --build-arg PIP_INDEX_URL=https://nexus.company.com/repository/pypi-proxy/simple \
#                --build-arg PIP_TRUSTED_HOST=nexus.company.com \
#                -f services/control_plane/Dockerfile -t metis-finops/control-plane:1.0.0 .
ARG BASE_IMAGE=python:3.12-slim
FROM ${BASE_IMAGE}
ARG PIP_INDEX_URL=https://pypi.org/simple
ARG PIP_TRUSTED_HOST=
ENV PIP_INDEX_URL=${PIP_INDEX_URL} PIP_TRUSTED_HOST=${PIP_TRUSTED_HOST}
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY services/control_plane/ .
EXPOSE 8500
CMD ["python", "app.py"]
