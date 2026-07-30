# Web service image for flooringpartners.portfolioapps.ai
ARG PYTHON_VERSION=3.12-slim-bookworm
FROM python:${PYTHON_VERSION}

# Create virtualenv
RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# Python settings
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

# OS dependencies — minimal. psycopg[binary] and pillow ship wheels, so
# gcc/libpq-dev are only here as a safety net for source builds.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libpq-dev \
    gcc \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /code

COPY requirements.txt /tmp/requirements.txt
RUN pip install --upgrade pip && pip install -r /tmp/requirements.txt

COPY ./src /code

COPY ./boot/docker-run.sh /opt/docker-run.sh
RUN chmod +x /opt/docker-run.sh

CMD ["/opt/docker-run.sh"]
