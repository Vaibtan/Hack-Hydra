/**
 * Engine-level test/probe surface. Production packages must use the typed
 * memory or authenticated admin services from the package root.
 */
export { HydraClient } from "./Client.js"
export type { Params, QueryOptions, RelRow, VertexRow } from "./Client.js"
export { FULL_KEY_PROPERTY, renderMsPathsQuery } from "./Cypher.js"
export type { MsPathsConfig } from "./Cypher.js"
export { isHydraPath } from "./Decode.js"
export type {
  HydraNode,
  HydraPath,
  HydraProperties,
  HydraRelationship,
  QueryResult,
  Row,
  Scalar
} from "./Decode.js"
export type { JsonObject, JsonValue } from "./JsonValue.js"
export { CurrentHydraBookmark } from "./Transport.js"
export {
  describeExecutionPlan,
  makeExecutionPlan,
  memoryEdgeFromHydra,
  memoryNodeFromHydra,
  memoryNodeFromRow,
  memoryPathFromHydra
} from "./Memory.js"
