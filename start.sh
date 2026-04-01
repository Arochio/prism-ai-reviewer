#!/bin/sh
set -e

# Run database migrations if DATABASE_URL is configured.
if [ -n "$DATABASE_URL" ]; then
  echo "Running database migrations..."
  node dist/db/migrate.js
fi

# Start the application.
exec node dist/index.js
