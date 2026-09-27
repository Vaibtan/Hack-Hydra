# LongMemEval — 140-question test split

Dataset `longmemeval_s`, prefix `g3`, profile `full`. Reader `gpt-5.6-luna`, judge `gpt-4o` with the official LongMemEval templates. Every number replays from `.cache/llm` for $0.00.

### bm25

| question type | n | abstention acc | accuracy | false-abst | SessionRecall@25 | reader tok p50 | latency p50 | A1 | A2 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| knowledge-update | 21 | 75.0 % | 100.0 % | 0.0 % | 100.0 % | 2,674 | 3.01 s | 0 | 0 |
| multi-session | 28 | 81.8 % | 41.2 % | 29.4 % | 100.0 % | 3,124 | 3.08 s | 0 | 0 |
| single-session-assistant | 20 | n/a | 100.0 % | 0.0 % | 100.0 % | 2,904 | 2.85 s | 0 | 0 |
| single-session-preference | 17 | n/a | 41.2 % | 17.6 % | 88.2 % | 2,533 | 3.16 s | 0 | 0 |
| single-session-user | 25 | 100.0 % | 95.5 % | 0.0 % | 100.0 % | 2,784 | 2.87 s | 0 | 0 |
| temporal-reasoning | 29 | 100.0 % | 69.6 % | 13.0 % | 95.7 % | 2,716 | 2.81 s | 0 | 0 |
| **ALL** | 140 | 87.5 % | 75.9 % | 9.5 % | 97.4 % | 2,836 | 2.96 s | 0 | 0 |

### fullctx

| question type | n | abstention acc | accuracy | false-abst | SessionRecall@25 | reader tok p50 | latency p50 | A1 | A2 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| knowledge-update | 21 | 75.0 % | 88.2 % | 0.0 % | 100.0 % | 111,210 | 4.11 s | 0 | 0 |
| multi-session | 28 | 81.8 % | 88.2 % | 5.9 % | 100.0 % | 110,971 | 3.79 s | 0 | 0 |
| single-session-assistant | 20 | n/a | 100.0 % | 0.0 % | 100.0 % | 112,056 | 3.62 s | 0 | 0 |
| single-session-preference | 17 | n/a | 47.1 % | 5.9 % | 100.0 % | 111,716 | 4.95 s | 0 | 0 |
| single-session-user | 25 | 100.0 % | 90.9 % | 0.0 % | 100.0 % | 111,878 | 3.49 s | 0 | 0 |
| temporal-reasoning | 29 | 100.0 % | 82.6 % | 4.3 % | 100.0 % | 111,629 | 3.57 s | 0 | 0 |
| **ALL** | 140 | 87.5 % | 83.6 % | 2.6 % | 100.0 % | 111,629 | 3.80 s | 0 | 0 |

### oracle-session

| question type | n | abstention acc | accuracy | false-abst | SessionRecall@25 | reader tok p50 | latency p50 | A1 | A2 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| knowledge-update | 21 | 100.0 % | 100.0 % | 0.0 % | 100.0 % | 6,490 | 2.84 s | 0 | 0 |
| multi-session | 28 | 90.9 % | 88.2 % | 0.0 % | 100.0 % | 7,327 | 3.01 s | 0 | 0 |
| single-session-assistant | 20 | n/a | 100.0 % | 0.0 % | 100.0 % | 2,009 | 2.40 s | 0 | 0 |
| single-session-preference | 17 | n/a | 52.9 % | 5.9 % | 100.0 % | 4,259 | 3.25 s | 0 | 0 |
| single-session-user | 25 | 100.0 % | 90.9 % | 0.0 % | 100.0 % | 3,753 | 2.62 s | 0 | 0 |
| temporal-reasoning | 29 | 100.0 % | 91.3 % | 0.0 % | 100.0 % | 6,828 | 2.83 s | 0 | 0 |
| **ALL** | 140 | 95.8 % | 87.9 % | 0.9 % | 100.0 % | 5,397 | 2.75 s | 0 | 0 |
