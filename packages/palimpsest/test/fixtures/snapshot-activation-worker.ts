import { Effect } from "effect"
import { createDatabase } from "../../src/IngestManifest/Schema.js"
import { createSnapshotOperations } from "../../src/IngestManifest/Snapshots.js"

const [path, tenant, uid, snapshotId, expectedManifestVersion] = process.argv.slice(2)
if (
  path === undefined ||
  tenant === undefined ||
  uid === undefined ||
  snapshotId === undefined ||
  expectedManifestVersion === undefined
) {
  throw new Error(
    "usage: snapshot-activation-worker <manifest-path> <tenant> <uid> <snapshot-id> <expected-manifest-version>"
  )
}

const database = createDatabase(path)
try {
  const snapshots = createSnapshotOperations(database)
  const outcome = await Effect.runPromise(
    snapshots
      .activateIndexSnapshot({
        tenant,
        uid,
        snapshotId,
        expectedManifestVersion: Number.parseInt(expectedManifestVersion, 10),
        expectedActiveSnapshotId: null
      })
      .pipe(Effect.result)
  )
  process.stdout.write(outcome._tag === "Success" ? "activated" : outcome.failure._tag)
} finally {
  database.close()
}
