ARG BASE_IMAGE=python:3.12-slim
FROM ${BASE_IMAGE}
ARG PIP_INDEX_URL=https://pypi.org/simple
ARG PIP_TRUSTED_HOST=
ENV PIP_INDEX_URL=${PIP_INDEX_URL} PIP_TRUSTED_HOST=${PIP_TRUSTED_HOST}
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY services/gateway/ .
EXPOSE 8400
CMD ["python", "app.py"]
