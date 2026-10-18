FROM python:3.12-alpine
WORKDIR /app
COPY app.py ./
COPY seed.py ./
COPY static/ ./static/
ENV PYTHONUNBUFFERED=1 GEAR_DATA=/data PORT=8080
VOLUME /data
EXPOSE 8080
CMD ["python", "app.py"]
