import { Effect } from "effect"
import { makeGraphClaimOperations } from "../../src/IngestManifest/GraphClaims.js"
import { createDatabase } from "../../src/IngestManifest/Schema.js"

const [path, canonicalIdentity] = process.argv.slice(2)
if (path === undefined || canonicalIdentity === undefined) {
  throw new Error("usage: graph-claim-worker <manifest-path> <canonical-identity>")
}

const database = createDatabase(path)
try {
  const claims = makeGraphClaimOperations(database, () => 4242)
  const outcome = await Effect.runPromise(
    claims
      .claimGraphId({ reducedId: 4242, kind: "relationship", canonicalIdentity })
      .pipe(Effect.either)
  )
  process.stdout.write(outcome._tag === "Right" ? outcome.right : outcome.left._tag)
} finally {
  database.close()
}
