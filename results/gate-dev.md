# Adoption gate — PASSED

Every bound below was written down in #22 before v2 produced a result.

| criterion | measured | bound | | why |
|---|---:|---:|:-:|---|
| correct gain on answerable | 6 | ≥ 3 | ✓ | v2 must win by more than a coin-flip's worth on 54 questions |
| worst per-type regression | 0 | ≥ -1 | ✓ | an aggregate gain must not hide a broken question type |
| false abstention on answerable (%) | 5.6 | ≤ 10 | ✓ | refusing an answerable question is the expensive failure |
| _abs questions answered correctly | 4 | ≥ 4 | ✓ | abstention accuracy must not be bought with coverage |
| graphMs p50 warm (ms) | 246 | ≤ 1500 | ✓ | the index's own latency claim, measured on a warm node |
| reader input tokens p50 | 890 | ≤ 6000 | ✓ | the 1/30th-of-full-context claim rests on this |
