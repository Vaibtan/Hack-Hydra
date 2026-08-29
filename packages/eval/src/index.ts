export { byType, questionRecall, summarise } from "./ExtractionRecall.js"
export type { QuestionRecall, RecallSummary, TurnCoverage } from "./ExtractionRecall.js"
export { benchmarkSlice, evalSlice, stratifiedSlice } from "./Slice.js"
export { gateByType, gateReport, scoreQuestion } from "./RetrievalMetrics.js"
export type { GateReport, QuestionRetrieval } from "./RetrievalMetrics.js"
export { JUDGE_MODEL, judge, judgeLabel, judgePrompt, judgeTemplate } from "./Judge.js"
export type { Judgement, JudgeTemplate } from "./Judge.js"
export { B, BM25_TOP_K, K1, buildIndex, fullContextSpans, score, topSpans } from "./Bm25.js"
export type { Bm25Index, FullContext } from "./Bm25.js"
export { SYSTEM_NAMES, isSystemName, refused, renderTable, summariseByType } from "./Results.js"
export type { EvalRow, SystemName, TypeSummary } from "./Results.js"
export {
  BENCHMARK_EXTRACTION_DEPENDENCIES,
  ExtractionGenerationDrift,
  SPLIT_FILE,
  assertGenerationMatches,
  liveExtractionGeneration,
  outsidePopulation,
  splitByCached
} from "./Splits.js"
export type { GateRecord, SplitFile, SplitName } from "./Splits.js"
export {
  ERROR_CLASSES,
  errorClass,
  errorClasses,
  mcnemarExact,
  paired,
  pairedDifferenceCi,
  pairedTable,
  renderErrorClasses,
  renderPaired
} from "./Tables.js"
export type { ErrorClass, ErrorClassCounts, PairedResult, PairedTable } from "./Tables.js"
export { oracleSessionSpans } from "./Oracle.js"
export { GATE_BOUNDS, falseAbstentions, readGate, renderGate, worstTypeRegression } from "./Gate.js"
export type { AdoptionGateReport, Criterion } from "./Gate.js"
