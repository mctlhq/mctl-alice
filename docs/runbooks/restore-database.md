# Restoring the alice database

Restores only the `labs-mctl-alice` database on the shared CloudNativePG
cluster `shared-pg` to a chosen point in time, without rolling back any other
tenant. Restoring `shared-pg` in place is not part of this procedure.

The backups are physical, so the scratch recovery cluster holds a copy of
**every** tenant database on `shared-pg`, not only alice's, on a temporary
billed volume. Treat the scratch namespace as admin-only and tear it down the
same day.

Conventions: `<db-ns>` is the namespace of `shared-pg`, `<scratch-ns>` a
temporary namespace, `<target-time>` a UTC time such as `2026-10-01T12:00:00Z`.
Database sessions run as the local `postgres` user inside a pod, because
network superuser access is disabled. Never print or `cat` the dump, secrets,
tokens or cookies, and never paste them into tickets.

> **Hard precondition:** the scratch recovery cluster must have **no
> `spec.backup` section** and must not archive WAL anywhere. A recovered
> cluster that archives into the production backup location corrupts the
> production timeline. Review the manifest before applying it.

## 1. Choose the target time

Pick a UTC time inside the 14-day retention window and after the oldest
available base backup.

```sh
kubectl get backups -n <db-ns>
```

Note the incident start and the oldest completed backup. The earliest
recoverable time must not be assumed; read it from this list.

## 2. Create the scratch recovery cluster

Create `<scratch-ns>` (admin access only: it will hold a copy of every tenant
database), give it a default-deny ingress NetworkPolicy that admits only the
app namespace, the CNPG operator namespace and pods in `<scratch-ns>` itself,
and copy the object-store credentials secret referenced by
`shared-pg` into it without printing it. Copy the `barmanObjectStore` block from the live
`shared-pg` Cluster spec (`kubectl get cluster shared-pg -n <db-ns> -o yaml`)
into `externalClusters`; do not retype it.

```yaml
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata:
  name: alice-restore
  namespace: <scratch-ns>
spec:
  instances: 1
  imageName: <same image as shared-pg>
  storage:
    # Size by data, not by the shared-pg volume: sum(pg_database_size) plus
    # WAL headroom. 10Gi (the provider minimum) was enough for ~2 GB of data.
    size: <data size plus headroom>
  bootstrap:
    recovery:
      source: shared-pg-origin
      recoveryTarget:
        targetTime: "<target-time>"
  externalClusters:
    - name: shared-pg-origin
      barmanObjectStore:
        # copied from the live shared-pg spec
        serverName: shared-pg
  # No "backup" section. See the precondition above.
```

Wait for the cluster to become healthy, then confirm the recovered point:

```sh
kubectl get cluster alice-restore -n <scratch-ns>
kubectl exec -n <scratch-ns> alice-restore-1 -c postgres -- \
  sh -c 'tail -1 "$(ls /var/lib/postgresql/data/pgdata/pg_wal/*.history | tail -1)"'
```

The last history line must read `before <target-time>`. Once the cluster is
promoted, `pg_last_xact_replay_timestamp()` returns NULL, so it cannot confirm
the stop point.

## 3. Dump only the alice database

```sh
kubectl exec -n <scratch-ns> alice-restore-1 -- env PGOPTIONS='-c statement_timeout=0' \
  pg_dump -U postgres -Fc --no-owner --no-acl -d labs-mctl-alice -f /var/lib/postgresql/data/alice.dump
```

The cluster default `statement_timeout` of 60s would cancel large `COPY`
statements, hence the option. Record the row counts of the restored tables
(`SELECT count(*)` per table). The dump stays inside the cluster network: copy
it pod to pod with `kubectl cp`, or pipe `pg_dump` into `pg_restore` through
two `kubectl exec` calls.

## 4. Restore into a fresh database

Target is `shared-pg` for a real restore, or the scratch cluster for an
exercise. In the primary pod, as local `postgres`:

```sh
psql -U postgres -c 'CREATE DATABASE "labs-mctl-alice-restore" OWNER "labs-mctl-alice" TEMPLATE template0'
PGOPTIONS='-c statement_timeout=0' pg_restore -U postgres --no-owner --no-acl \
  --role=labs-mctl-alice -d labs-mctl-alice-restore /var/lib/postgresql/data/alice.dump
```

`--role` makes every object owned by the app role. `TEMPLATE template0` keeps
out the `user_search` function CNPG adds to `template1` for PgBouncer;
without it `pg_restore` exits 1 on that one duplicate object. The live
database is not touched. The new database is not declared in gitops.

## 5. Switch over, then verify before serving

`DATABASE_URL`, pg_hba and the CNPG `Database` resource stay unchanged; the
database names are swapped instead. The check runs against the live name, as
the app role, before any traffic returns.

1. Stop the app and keep it stopped: pause ArgoCD auto-sync for
   `labs-mctl-alice` (or commit `replicaCount: 0` in gitops), then:

```sh
kubectl scale deploy/labs-mctl-alice-base-service -n labs --replicas=0
kubectl rollout status deploy/labs-mctl-alice-base-service -n labs --timeout=60s
kubectl get pods -n labs -l app.kubernetes.io/name=mctl-alice   # expect none
```

   Confirm zero pods before continuing: a running pod reconnects after
   `pg_terminate_backend`.
2. As local `postgres` on the primary:

```sql
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'labs-mctl-alice';
ALTER DATABASE "labs-mctl-alice" RENAME TO "labs-mctl-alice-pre-restore-<yyyymmdd>";
ALTER DATABASE "labs-mctl-alice-restore" RENAME TO "labs-mctl-alice";
```

3. Run `restore-check` as the app role against the live name, from a one-off
   Pod manifest in `labs` (see "One-off check pod" below), using the
   app's own secrets for `DATABASE_URL` and the encryption key. No `--as-role`
   and no superuser URL are needed; the tool refuses to run without
   `ENCRYPTION_KEY` or `ENCRYPTION_KEYS`. It is read-only and prints counts only.
   Exit code 0 means every check passed; compare the table counts with section 3.
4. On a non-zero exit, reverse the rename (see "Rolling back a switch-over")
   before scaling up. A `clear-text-credentials` failure means the target
   predates credential encryption; restore a later target, or fix the data
   on the scratch copy before switching.
5. Only on exit 0, scale back to 1 and re-enable auto-sync.

If sessions cannot be terminated, the fallback is to point the app at the new
database name through its database secret and a pg_hba line; that needs a
reviewed gitops change.

## 6. Verify the live service

- `/readyz` returns 200.
- The startup log has no "cannot be decrypted with any configured key" line
  and no "still in clear text" line.
- A test account can open `/account` and list devices.
- Re-run `restore-check` against `labs-mctl-alice`.

## One-off check pod

`kubectl run` has no `--env-from`, so apply a Pod manifest instead. It needs:

- `envFrom` with `mctl-alice-secrets` and `labs-mctl-alice-db-creds`;
- `imagePullSecrets: [{name: ghcr-credentials}]`, or the pull fails on a node
  without the image cached;
- the deployment's restricted `securityContext` (non-root, read-only root,
  all capabilities dropped, `RuntimeDefault` seccomp) and
  `automountServiceAccountToken: false`;
- a wait of about 30 s before connecting: the cluster's NetworkPolicy
  controller admits a new pod's IP only after its next sync, and until then
  every connection is refused (`ECONNREFUSED`), even to `shared-pg`.

The entrypoint is `node --input-type=module -e` with a short script that
sleeps, then imports `dist/restore-check.js`. For an exercise against the
scratch cluster, the same script rewrites the host and database in
`DATABASE_URL` and refuses to run if the URL does not have the expected
production shape. Delete the pod afterwards.

## 7. Clean up

Delete the scratch Cluster, its PVCs, the namespace and every dump file.
Keep `labs-mctl-alice-pre-restore-<yyyymmdd>` for 7 days, then
`DROP DATABASE` it and note the drop in the log.

## Rolling back a switch-over

With the app scaled to zero and sessions terminated, rename `labs-mctl-alice`
back to `labs-mctl-alice-restore` and the `-pre-restore-<yyyymmdd>` database
back to `labs-mctl-alice`, then scale up.

## What to check after a restore

| Check | Why it matters |
| --- | --- |
| Row counts match the source at the target time | Detects a partial restore |
| All tables exist and are usable by the app role | The app role must own the objects |
| Credentials decrypt with the current key | The key active at the target time must still be configured; add an old key to `ENCRYPTION_KEYS` rather than deleting rows. Keep keys as long as the backups that need them |
| No clear-text bearer secrets | A target before 2.2.3 brings them back; set `REHASH_STORED_SECRETS=true` once |
| Tokens and sessions issued after the target time are gone | Users who connected later must reconnect |
| Yandex refresh tokens rotated after the target time may be invalid upstream | Affected users sign in again; this is expected |

## Exercise log

Record counts only: no hostnames, bucket names, endpoints, secret paths or
credentials.

| Date | Operator role | Target time | Phase durations | Check output (counts) | Deviations | Scratch target torn down |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-10-22 | Platform operator (agent session; owner approved each cluster step) | 2026-10-22T12:00:00Z (scratch cluster only, no switch-over) | Recovery 3m06s; dump 4s (7.4 MB); `pg_restore` 30s; check 35s; teardown under 2 min | `restore-check` exit 0, `failures: []`; 10/10 tables usable; rows: users 3, user_credentials 3, web_sessions 24, browser_transactions 3, oauth_clients 34, oauth_pending 5, oauth_codes 8, oauth_tokens 12, quasar_proxy_scenarios 0, telemetry_samples 1390974 (equal to the source); credentials 39, undecryptable 0, notUnderActiveKey 39; clear-text secrets 0, clear-text credentials 0 | Volume 10Gi instead of 40Gi; `pg_restore` exit 1 on the CNPG `user_search` function (now `TEMPLATE template0`); check pod needed `imagePullSecrets` and a 30 s NetworkPolicy settle delay; stop point read from the timeline history file | Yes: Cluster, PVC, PV and namespace deleted the same hour |

Follow-up: all 39 credential rows are still encrypted under a previous key in
`ENCRYPTION_KEYS`, not the active one. Do not remove that key until the rows
are re-encrypted.
