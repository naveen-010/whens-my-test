# Database restore

Restores overwrite application data. Stop the API and worker first and take a fresh backup.

```bash
cd /home/ubuntu/whens-my-test
docker compose stop api worker
gzip -dc backups/whens_my_test-YYYYMMDDTHHMMSSZ.sql.gz |
  docker compose exec -T db psql -U whens_my_test -d whens_my_test
docker compose start api worker
```

Backups in `/home/ubuntu/whens-my-test/backups` protect against application mistakes but not loss of the Oracle instance. Copy them to a second machine or object-storage bucket.
