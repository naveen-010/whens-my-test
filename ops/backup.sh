#!/usr/bin/env sh
set -eu

umask 077
deployment_dir=/home/ubuntu/whens-my-test
backup_dir="$deployment_dir/backups"
timestamp=$(date -u +%Y%m%dT%H%M%SZ)
temporary_file="$backup_dir/.whens_my_test-$timestamp.sql.gz.tmp"
final_file="$backup_dir/whens_my_test-$timestamp.sql.gz"

mkdir -p "$backup_dir"
cd "$deployment_dir"
docker compose exec -T db pg_dump -U whens_my_test -d whens_my_test \
  --no-owner --no-privileges | gzip -9 > "$temporary_file"
mv "$temporary_file" "$final_file"
find "$backup_dir" -type f -name 'whens_my_test-*.sql.gz' -mtime +14 -delete
