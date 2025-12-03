FROM python:3.11-slim
WORKDIR /app
COPY . /app
RUN pip install --upgrade pip && pip install -r requirements.txt
ENV PORT=8000
EXPOSE 8000
CMD ["gunicorn", "server_full:app", "--bind", "0.0.0.0:8000", "--workers", "1"]
