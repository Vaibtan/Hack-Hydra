# LongMemEval — 20-question slice

Dataset `longmemeval_s`, prefix `g2`. Reader `gpt-5.6-luna`, judge `gpt-4o` with the official LongMemEval templates. Every number replays from `.cache/llm` for $0.00.

### fullctx

| question type | n | abstention acc | accuracy | false-abst | SessionRecall@25 | reader tok p50 | latency p50 | A1 | A2 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| knowledge-update | 4 | 0.0 % | 100.0 % | 0.0 % | 100.0 % | 111,820 | 4.49 s | 0 | 0 |
| multi-session | 4 | n/a | 100.0 % | 0.0 % | 100.0 % | 111,870 | 4.71 s | 0 | 0 |
| single-session-assistant | 3 | n/a | 100.0 % | 0.0 % | 100.0 % | 109,844 | 3.02 s | 0 | 0 |
| single-session-preference | 3 | n/a | 100.0 % | 0.0 % | 100.0 % | 110,628 | 5.40 s | 0 | 0 |
| single-session-user | 3 | 100.0 % | 100.0 % | 0.0 % | 100.0 % | 111,191 | 3.10 s | 0 | 0 |
| temporal-reasoning | 3 | n/a | 100.0 % | 0.0 % | 100.0 % | 111,385 | 3.64 s | 0 | 0 |
| **ALL** | 20 | 50.0 % | 100.0 % | 0.0 % | 100.0 % | 111,265 | 4.25 s | 0 | 0 |

