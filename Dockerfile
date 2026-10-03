# Stage 1: Build the React/Three.js frontend
FROM node:22-alpine AS frontend-builder
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# Stage 2: Python 3.12 runtime with PyTorch dependencies
FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8080

WORKDIR /app

# System dependencies for OpenCV and graphical pipelines
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

COPY backend/requirements.txt ./backend/
RUN pip install --no-cache-dir -r backend/requirements.txt
# ZoeDepth/MiDaS use timm 0.6.12; omit optional Hub clients and safetensors.
RUN pip install --no-cache-dir --no-deps timm==0.6.12

COPY backend/ ./backend/
COPY run_single_server.py ./
COPY --from=frontend-builder /app/frontend/dist ./frontend/dist

EXPOSE 8080
CMD ["python", "run_single_server.py", "--host", "0.0.0.0", "--port", "8080"]
