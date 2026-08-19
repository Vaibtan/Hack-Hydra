# LongMemEval — 20-question slice

Dataset `longmemeval_s`, prefix `g2`. Reader `gpt-5.6-luna`, judge `gpt-4o` with the official LongMemEval templates. Every number replays from `.cache/llm` for $0.00.

### palimpsest

| question type | n | abstention acc | accuracy | false-abst | SessionRecall@25 | reader tok p50 | latency p50 | A1 | A2 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| knowledge-update | 4 | 0.0 % | 100.0 % | 0.0 % | 100.0 % | 4,206 | 27.07 s | 0 | 0 |
| multi-session | 4 | n/a | 100.0 % | 0.0 % | 100.0 % | 4,125 | 25.25 s | 0 | 0 |
| single-session-assistant | 3 | n/a | 66.7 % | 0.0 % | 100.0 % | 3,565 | 27.36 s | 0 | 0 |
| single-session-preference | 3 | n/a | 66.7 % | 0.0 % | 100.0 % | 3,072 | 24.18 s | 0 | 0 |
| single-session-user | 3 | 100.0 % | 100.0 % | 0.0 % | 100.0 % | 1,816 | 21.00 s | 0 | 0 |
| temporal-reasoning | 3 | n/a | 100.0 % | 0.0 % | 100.0 % | 3,564 | 21.07 s | 0 | 0 |
| **ALL** | 20 | 50.0 % | 88.9 % | 0.0 % | 100.0 % | 3,591 | 24.17 s | 0 | 0 |

### palimpsest-premise

| question type | n | abstention acc | accuracy | false-abst | SessionRecall@25 | reader tok p50 | latency p50 | A1 | A2 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| knowledge-update | 4 | 100.0 % | 100.0 % | 0.0 % | 100.0 % | 4,344 | 19.60 s | 0 | 0 |
| multi-session | 4 | n/a | 100.0 % | 0.0 % | 100.0 % | 4,263 | 18.27 s | 0 | 0 |
| single-session-assistant | 3 | n/a | 66.7 % | 33.3 % | 100.0 % | 3,703 | 20.49 s | 0 | 0 |
| single-session-preference | 3 | n/a | 66.7 % | 33.3 % | 100.0 % | 3,210 | 19.88 s | 0 | 0 |
| single-session-user | 3 | 100.0 % | 100.0 % | 0.0 % | 100.0 % | 1,954 | 15.88 s | 0 | 0 |
| temporal-reasoning | 3 | n/a | 100.0 % | 0.0 % | 100.0 % | 3,702 | 15.97 s | 0 | 0 |
| **ALL** | 20 | 100.0 % | 88.9 % | 11.1 % | 100.0 % | 3,729 | 18.54 s | 0 | 0 |

