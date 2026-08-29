import type { Receipt as RetrievalReceipt } from "@palimpsest/palimpsest"

/**
 * Projects the retrieval trace into the HTTP contract without dropping any
 * input required to replay the diagnostic rendering.
 */
export const projectRetrievalReceipt = (receipt: RetrievalReceipt) => ({
  question: receipt.question,
  uid: receipt.uid,
  asOf: receipt.asOf,
  anchorTerms: receipt.anchorTerms,
  anchorsReachingClaims: receipt.anchorsReachingClaims,
  anchorsReachingNothing: receipt.anchorsReachingNothing,
  historical: receipt.historical,
  wantsCount: receipt.wantsCount,
  timeRef: receipt.timeRef,
  convergenceThreshold: receipt.convergenceThreshold,
  totalClaims: receipt.totalClaims,
  query1: receipt.query1,
  query1Params: receipt.query1Params,
  query1Paths: receipt.query1Paths,
  query2: receipt.query2,
  query2Paths: receipt.query2Paths,
  convergence: receipt.convergence
})
