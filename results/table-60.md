# LongMemEval — 60-question slice

Dataset `longmemeval_s`, prefix `g2`. Reader `gpt-5.6-luna`, judge `gpt-4o` with the official LongMemEval templates. Every number replays from `.cache/llm` for $0.00.

> **Partial slice.** 60 of a requested 100 questions. The other 40 users are not indexed in this graph, so they are excluded rather than counted as retrieval failures. Every column below is over the 60 that are.

### palimpsest

| question type | n | abstention acc | accuracy | false-abst | SessionRecall@25 | reader tok p50 | latency p50 | A1 | A2 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| knowledge-update | 14 | 50.0 % | 91.7 % | 0.0 % | 100.0 % | 3,950 | 14.20 s | 0 | 0 |
| multi-session | 13 | 0.0 % | 83.3 % | 8.3 % | 100.0 % | 3,728 | 14.42 s | 0 | 0 |
| single-session-assistant | 8 | n/a | 87.5 % | 0.0 % | 100.0 % | 3,618 | 19.59 s | 0 | 0 |
| single-session-preference | 11 | n/a | 45.5 % | 9.1 % | 90.9 % | 3,452 | 17.51 s | 0 | 0 |
| single-session-user | 9 | 100.0 % | 100.0 % | 0.0 % | 100.0 % | 3,517 | 17.25 s | 0 | 0 |
| temporal-reasoning | 5 | n/a | 80.0 % | 0.0 % | 100.0 % | 3,555 | 15.25 s | 0 | 0 |
| **ALL** | 60 | 66.7 % | 79.6 % | 3.7 % | 98.1 % | 3,658 | 15.15 s | 0 | 0 |

### palimpsest-premise

| question type | n | abstention acc | accuracy | false-abst | SessionRecall@25 | reader tok p50 | latency p50 | A1 | A2 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| knowledge-update | 14 | 100.0 % | 75.0 % | 8.3 % | 100.0 % | 4,088 | 16.89 s | 0 | 0 |
| multi-session | 13 | 0.0 % | 66.7 % | 16.7 % | 100.0 % | 3,866 | 17.50 s | 0 | 0 |
| single-session-assistant | 8 | n/a | 87.5 % | 12.5 % | 100.0 % | 3,756 | 17.95 s | 0 | 0 |
| single-session-preference | 11 | n/a | 27.3 % | 45.5 % | 90.9 % | 3,590 | 18.27 s | 0 | 0 |
| single-session-user | 9 | 100.0 % | 100.0 % | 0.0 % | 100.0 % | 3,655 | 16.55 s | 0 | 0 |
| temporal-reasoning | 5 | n/a | 80.0 % | 20.0 % | 100.0 % | 3,693 | 14.21 s | 0 | 0 |
| **ALL** | 60 | 83.3 % | 68.5 % | 18.5 % | 98.1 % | 3,796 | 17.48 s | 0 | 0 |

### bm25

| question type | n | abstention acc | accuracy | false-abst | SessionRecall@25 | reader tok p50 | latency p50 | A1 | A2 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| knowledge-update | 14 | 100.0 % | 91.7 % | 8.3 % | 100.0 % | 2,617 | 2.71 s | 0 | 0 |
| multi-session | 13 | 0.0 % | 83.3 % | 8.3 % | 100.0 % | 3,398 | 2.55 s | 0 | 0 |
| single-session-assistant | 8 | n/a | 87.5 % | 12.5 % | 100.0 % | 2,464 | 2.45 s | 0 | 0 |
| single-session-preference | 11 | n/a | 36.4 % | 36.4 % | 72.7 % | 2,773 | 2.73 s | 0 | 0 |
| single-session-user | 9 | 100.0 % | 83.3 % | 0.0 % | 100.0 % | 2,534 | 2.71 s | 0 | 0 |
| temporal-reasoning | 5 | n/a | 80.0 % | 0.0 % | 100.0 % | 2,767 | 0.06 s | 0 | 0 |
| **ALL** | 60 | 83.3 % | 75.9 % | 13.0 % | 94.4 % | 2,787 | 2.60 s | 0 | 0 |

### fullctx

| question type | n | abstention acc | accuracy | false-abst | SessionRecall@25 | reader tok p50 | latency p50 | A1 | A2 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| knowledge-update | 14 | 50.0 % | 100.0 % | 0.0 % | 100.0 % | 110,591 | 3.53 s | 0 | 0 |
| multi-session | 13 | 0.0 % | 83.3 % | 0.0 % | 100.0 % | 111,352 | 3.64 s | 0 | 0 |
| single-session-assistant | 8 | n/a | 100.0 % | 0.0 % | 100.0 % | 110,679 | 2.60 s | 0 | 0 |
| single-session-preference | 11 | n/a | 54.5 % | 18.2 % | 100.0 % | 111,385 | 3.51 s | 0 | 0 |
| single-session-user | 9 | 100.0 % | 83.3 % | 0.0 % | 100.0 % | 111,092 | 3.43 s | 0 | 0 |
| temporal-reasoning | 5 | n/a | 80.0 % | 0.0 % | 100.0 % | 110,886 | 0.00 s | 0 | 0 |
| **ALL** | 60 | 66.7 % | 83.3 % | 3.7 % | 100.0 % | 111,057 | 3.42 s | 0 | 0 |

