export { byType, questionRecall, summarise } from "./ExtractionRecall.js"
export type { QuestionRecall, RecallSummary, TurnCoverage } from "./ExtractionRecall.js"
export { benchmarkSlice, evalSlice, stratifiedSlice } from "./Slice.js"
export { gateByType, gateReport, scoreQuestion } from "./RetrievalMetrics.js"
export type { GateReport, QuestionRetrieval } from "./RetrievalMetrics.js"
export { JUDGE_MODEL, judge, judgeLabel, judgePrompt, judgeTemplate } from "./Judge.js"
export type { Judgement, JudgeTemplate } from "./Judge.js"
export { B, BM25_TOP_K, K1, buildIndex, fullContextSpans, score, topSpans } from "./Bm25.js"
export type { Bm25Index, FullContext } from "./Bm25.js"
export {
  ABSTENTION_REASONS,
  EvalEnvelope,
  EvalRow,
  MEASUREMENT_FIELDS,
  SUFFICIENCY_TIERS,
  SYSTEM_NAMES,
  ablationToken,
  decodeEnvelope,
  envelopeVariant,
  isBatchFile,
  isSystemName,
  readEnvelope,
  resultsStem,
  variantTokens,
  writeAtomic,
  writeEnvelopeAtomic,
  writeEnvelopeExclusive,
  writeExclusive
} from "./Envelope.js"
export type { SystemName } from "./Envelope.js"
export {
  abstentions,
  answerable,
  correct,
  refused,
  renderRunTable,
  renderTable,
  summariseByType
} from "./Results.js"
export type { TypeSummary } from "./Results.js"
export { median, pct, quantile, ratio } from "./Stats.js"
export {
  BENCHMARK_EXTRACTION_DEPENDENCIES,
  COMPLETIONS,
  EXCLUSION_REASONS,
  Exclusion,
  ExtractionGenerationDrift,
  GateRecord,
  INGESTION_EVIDENCE_KINDS,
  INGESTION_STATES,
  IngestedPopulation,
  PopulationSection,
  SPLIT_FILE,
  SplitFile,
  assertGenerationMatches,
  isVerifiedIngestion,
  liveExtractionGeneration,
  normaliseIngested,
  normalisePopulation,
  outsidePopulation,
  splitByCached
} from "./Splits.js"
export type {
  Completion,
  ExclusionReason,
  IngestionEvidenceKind,
  IngestionState,
  NormalisedPopulation,
  PopulationCount,
  SplitName
} from "./Splits.js"
export {
  PopulationRecord,
  RECONCILIATION_STATUSES,
  RECONCILE_FILE,
  ReconcileWitness,
  ReconciledUser,
  buildPopulationRecord,
  buildReconciledUser,
  completionFromWitness,
  datasetSha256,
  exclusionReasons,
  exclusionsFrom,
  ingestionFailures,
  membershipFailures,
  membershipOf,
  observedSplits,
  parseReconcileWitness,
  populationGateFailures,
  reconcileWitnessFailures,
  splitMembershipSha256,
  sha256Text,
  witnessQuestionIds
} from "./PopulationAudit.js"
export type {
  BuildReconciledUserInput,
  BuildPopulationRecordInput,
  PopulationGateInput,
  PopulationMembership,
  ReconcileWitnessContext,
  ReconciliationStatus
} from "./PopulationAudit.js"
export {
  batchOf,
  leakedTestIds,
  notIngested,
  readSplitFile,
  splitFilePath,
  splitQuestions,
  testGateRefusal,
  uidFor,
  workspaceRoot
} from "./Population.js"
export {
  CliError,
  ablationNames,
  arg,
  flag,
  orExit,
  parseAblations,
  parseBatch,
  parseDataset,
  parseGranularity,
  parseProfile,
  parseSplit
} from "./Cli.js"
export type { AblationFlags, Batch } from "./Cli.js"
export { mergeBatches } from "./Batches.js"
export type { BatchPart, MergedBatches } from "./Batches.js"
export {
  absentResponse,
  evidenceBytesSha256,
  graphMsOf,
  responseOf,
  rowFromBaseline,
  rowFromV2
} from "./Row.js"
export type { BaselineOutcome, BaselineRead, SystemOutcome, V2Outcome } from "./Row.js"
export { legacyFreezeFindings, legacyHarnessSha256, readLegacyFreeze, resolveFrozenOutput } from "./LegacyFreeze.js"
export type { LegacyFreeze, LegacyFreezePurpose, LoadedLegacyFreeze } from "./LegacyFreeze.js"
export { legacyQualificationFindings, readLegacyQualification } from "./LegacyQualification.js"
export type { LegacyQualificationFreeze, LoadedLegacyQualification } from "./LegacyQualification.js"
export { LIVE_SYSTEMS, RETIRED_SYSTEMS, SYSTEMS } from "./Systems.js"
export type { SystemDeps, SystemSpec, V2Options } from "./Systems.js"
export {
  ERROR_CLASSES,
  errorClass,
  errorClasses,
  mcnemarExact,
  paired,
  pairedDifferenceCi,
  pairedTable,
  renderAblations,
  renderErrorClasses,
  renderLatency,
  renderPaired
} from "./Tables.js"
export type { AblationRow, ErrorClass, ErrorClassCounts, PairedResult, PairedTable } from "./Tables.js"
export { oracleSessionSpans } from "./Oracle.js"
export {
  GATE_BOUNDS,
  falseAbstentions,
  gateRefusals,
  overwriteRefusal,
  readGate,
  renderGate,
  worstTypeRegression
} from "./Gate.js"
export type { AdoptionGateReport, Criterion, GateEnvelope } from "./Gate.js"
export {
  canonicalise,
  configEnv,
  fromInspected,
  hashRuntimeConfig,
  readRuntimeConfig
} from "./RuntimeConfig.js"
export type {
  HydraRuntimeConfig,
  HydraRuntimeConfigUnavailable,
  InspectedContainer,
  RuntimeConfigInput,
  RuntimeConfigResult
} from "./RuntimeConfig.js"
export { disagreements, renderReaderAb, summariseReaderAb } from "./ReaderAb.js"
export type { ReaderAbArm, ReaderAbFile, ReaderAbRow, ReaderAbSummary } from "./ReaderAb.js"
