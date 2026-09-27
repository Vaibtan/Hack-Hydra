# LongMemEval — 60-question dev

Dataset `longmemeval_s`, prefix `g3`, split `dev`, profile `full`. Reader `gpt-5.6-luna`, selector `gpt-5.6-luna`, sufficiency `gpt-5.6-luna`, judge `gpt-4o` with the official LongMemEval templates. Extraction generation `extract-v1-fffef7bb23a92938adeba1bd1b781a016b019a7bfac75708368dc719fd4de6e4`.

Rebuilt by `pnpm table` from the results JSON alone.

## Accuracy by question type

### palimpsest

| question type | n | abstention acc | accuracy | false-abst | SessionRecall@25 | reader tok p50 | latency p50 | A1 | A2 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| knowledge-update | 14 | 50.0 % | 91.7 % | 0.0 % | 100.0 % | 3,950 | 0.12 s | 0 | 0 |
| multi-session | 13 | 0.0 % | 83.3 % | 8.3 % | 100.0 % | 3,728 | 0.10 s | 0 | 0 |
| single-session-assistant | 8 | n/a | 87.5 % | 0.0 % | 100.0 % | 3,618 | 0.22 s | 0 | 0 |
| single-session-preference | 11 | n/a | 45.5 % | 9.1 % | 90.9 % | 3,452 | 0.13 s | 0 | 0 |
| single-session-user | 9 | 100.0 % | 100.0 % | 0.0 % | 100.0 % | 3,517 | 0.10 s | 0 | 0 |
| temporal-reasoning | 5 | n/a | 80.0 % | 0.0 % | 100.0 % | 3,555 | 0.12 s | 0 | 0 |
| **ALL** | 60 | 66.7 % | 79.6 % | 3.7 % | 98.1 % | 3,658 | 0.12 s | 0 | 0 |

### palimpsest-v2

| question type | n | abstention acc | accuracy | false-abst | SessionRecall@25 | reader tok p50 | latency p50 | A1 | A2 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| knowledge-update | 14 | 50.0 % | 100.0 % | 0.0 % | 100.0 % | 784 | 0.34 s | 0 | 0 |
| multi-session | 13 | 0.0 % | 83.3 % | 0.0 % | 100.0 % | 1,090 | 0.30 s | 0 | 0 |
| single-session-assistant | 8 | n/a | 100.0 % | 0.0 % | 100.0 % | 930 | 0.28 s | 0 | 0 |
| single-session-preference | 11 | n/a | 81.8 % | 18.2 % | 100.0 % | 3,909 | 0.34 s | 0 | 0 |
| single-session-user | 9 | 100.0 % | 100.0 % | 0.0 % | 100.0 % | 849 | 0.26 s | 0 | 0 |
| temporal-reasoning | 5 | n/a | 80.0 % | 20.0 % | 80.0 % | 973 | 0.36 s | 0 | 0 |
| **ALL** | 60 | 66.7 % | 90.7 % | 5.6 % | 98.1 % | 890 | 0.32 s | 0 | 0 |

### oracle-session

| question type | n | abstention acc | accuracy | false-abst | SessionRecall@25 | reader tok p50 | latency p50 | A1 | A2 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| knowledge-update | 14 | 50.0 % | 100.0 % | 0.0 % | 100.0 % | 6,267 | 3.31 s | 0 | 0 |
| multi-session | 13 | 0.0 % | 83.3 % | 0.0 % | 100.0 % | 7,501 | 3.78 s | 0 | 0 |
| single-session-assistant | 8 | n/a | 100.0 % | 0.0 % | 100.0 % | 1,382 | 2.70 s | 0 | 0 |
| single-session-preference | 11 | n/a | 54.5 % | 27.3 % | 100.0 % | 4,602 | 3.71 s | 0 | 0 |
| single-session-user | 9 | 100.0 % | 83.3 % | 0.0 % | 100.0 % | 3,665 | 2.79 s | 0 | 0 |
| temporal-reasoning | 5 | n/a | 100.0 % | 0.0 % | 100.0 % | 8,091 | 2.58 s | 0 | 0 |
| **ALL** | 60 | 66.7 % | 85.2 % | 5.6 % | 100.0 % | 5,812 | 3.25 s | 0 | 0 |

### bm25

| question type | n | abstention acc | accuracy | false-abst | SessionRecall@25 | reader tok p50 | latency p50 | A1 | A2 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| knowledge-update | 14 | 100.0 % | 91.7 % | 8.3 % | 100.0 % | 2,662 | 0.30 s | 0 | 0 |
| multi-session | 13 | 0.0 % | 83.3 % | 8.3 % | 100.0 % | 3,398 | 0.22 s | 0 | 0 |
| single-session-assistant | 8 | n/a | 87.5 % | 12.5 % | 100.0 % | 2,464 | 0.09 s | 0 | 0 |
| single-session-preference | 11 | n/a | 45.5 % | 36.4 % | 72.7 % | 2,773 | 0.21 s | 0 | 0 |
| single-session-user | 9 | 100.0 % | 83.3 % | 0.0 % | 100.0 % | 2,534 | 0.09 s | 0 | 0 |
| temporal-reasoning | 5 | n/a | 80.0 % | 20.0 % | 100.0 % | 2,767 | 0.25 s | 0 | 0 |
| **ALL** | 60 | 83.3 % | 77.8 % | 14.8 % | 94.4 % | 2,787 | 0.18 s | 0 | 0 |

### fullctx

| question type | n | abstention acc | accuracy | false-abst | SessionRecall@25 | reader tok p50 | latency p50 | A1 | A2 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| knowledge-update | 14 | 50.0 % | 100.0 % | 0.0 % | 100.0 % | 111,208 | 0.19 s | 0 | 0 |
| multi-session | 13 | 0.0 % | 83.3 % | 0.0 % | 100.0 % | 111,393 | 0.11 s | 0 | 0 |
| single-session-assistant | 8 | n/a | 100.0 % | 0.0 % | 100.0 % | 111,707 | 0.04 s | 0 | 0 |
| single-session-preference | 11 | n/a | 54.5 % | 18.2 % | 100.0 % | 111,496 | 0.11 s | 0 | 0 |
| single-session-user | 9 | 100.0 % | 83.3 % | 0.0 % | 100.0 % | 111,191 | 0.09 s | 0 | 0 |
| temporal-reasoning | 5 | n/a | 80.0 % | 0.0 % | 100.0 % | 110,886 | 0.19 s | 0 | 0 |
| **ALL** | 60 | 66.7 % | 83.3 % | 3.7 % | 100.0 % | 111,369 | 0.11 s | 0 | 0 |

## Where the wrong answers were lost

One class per incorrect answer, as a funnel: a question whose answer session no candidate arm reached is a `retrieval miss` and cannot also be a selection loss. A v1 row records no candidate union, so its funnel collapses to `retrieval miss` or `reader`.

| system | wrong | retrieval miss | selection | packing | reader | premise |
|---|---:|---:|---:|---:|---:|---:|
| palimpsest | 13 | 1 | 0 | 0 | 10 | 2 |
| palimpsest-v2 | 7 | 0 | 1 | 0 | 4 | 2 |
| oracle-session | 10 | 0 | 0 | 0 | 8 | 2 |
| bm25 | 13 | 3 | 0 | 0 | 9 | 1 |
| fullctx | 11 | 0 | 0 | 0 | 9 | 2 |

## Latency and reader cost

`graphMs` is the HydraDB stages alone — arms, edges, hydration — and never includes an LLM round trip; `askMs` is the whole ask. p90 is here because a p50 alone hides the shape: a pipeline whose median ask is 3 s and whose ninetieth percentile is 40 s is not a 3 s pipeline, and the one question in ten that takes 40 s is the one the audience asks.

| system | graphMs p50 | graphMs p90 | askMs p50 | askMs p90 | reader tokens p50 | p90 |
|---|---:|---:|---:|---:|---:|---:|
| palimpsest | 115 ms | 225 ms | 103 ms | 214 ms | 3,658 | 4,711 |
| palimpsest-v2 | 246 ms | 467 ms | 250 ms | 474 ms | 890 | 3,680 |
| oracle-session | — | — | — | — | 5,812 | 8,891 |
| bm25 | — | — | — | — | 2,787 | 3,774 |
| fullctx | — | — | — | — | 111,369 | 112,709 |

## Ablations

Each row is the full v2 plan with one stage switched off. The difference is that stage's contribution *in the presence of every other stage* — two stages that each look worthless alone can be jointly necessary, and one that looks valuable may only be compensating for a weakness elsewhere. A stage whose removal helps is reported the same way as one whose removal hurts; that is the number most worth having.

_No ablation runs in this directory._

## Paired comparisons

**palimpsest-v2** vs **palimpsest** — 54 answerable questions both systems answered

| outcome | questions |
|---|---:|
| both correct | 42 |
| palimpsest-v2 only | 7 |
| palimpsest only | 1 |
| both wrong | 4 |

Paired difference **+11.11 pp** (95 % CI +1.19 to +21.03), exact two-sided McNemar **p = 0.0703125** over 8 discordant pairs.

**oracle-session** vs **palimpsest** — 54 answerable questions both systems answered

| outcome | questions |
|---|---:|
| both correct | 40 |
| oracle-session only | 6 |
| palimpsest only | 3 |
| both wrong | 5 |

Paired difference **+5.56 pp** (95 % CI -5.33 to +16.44), exact two-sided McNemar **p = 0.5078125** over 9 discordant pairs.

**bm25** vs **palimpsest** — 54 answerable questions both systems answered

| outcome | questions |
|---|---:|
| both correct | 38 |
| bm25 only | 4 |
| palimpsest only | 5 |
| both wrong | 7 |

Paired difference **-1.85 pp** (95 % CI -12.83 to +9.13), exact two-sided McNemar **p = 1.0000000** over 9 discordant pairs.

**fullctx** vs **palimpsest** — 54 answerable questions both systems answered

| outcome | questions |
|---|---:|
| both correct | 41 |
| fullctx only | 4 |
| palimpsest only | 2 |
| both wrong | 7 |

Paired difference **+3.70 pp** (95 % CI -5.21 to +12.62), exact two-sided McNemar **p = 0.6875000** over 6 discordant pairs.

**palimpsest-v2** vs **bm25** — 54 answerable questions both systems answered

| outcome | questions |
|---|---:|
| both correct | 41 |
| palimpsest-v2 only | 8 |
| bm25 only | 1 |
| both wrong | 4 |

Paired difference **+12.96 pp** (95 % CI +2.54 to +23.39), exact two-sided McNemar **p = 0.0390625** over 9 discordant pairs.

**oracle-session** vs **bm25** — 54 answerable questions both systems answered

| outcome | questions |
|---|---:|
| both correct | 41 |
| oracle-session only | 5 |
| bm25 only | 1 |
| both wrong | 7 |

Paired difference **+7.41 pp** (95 % CI -1.34 to +16.16), exact two-sided McNemar **p = 0.2187500** over 6 discordant pairs.

**fullctx** vs **bm25** — 54 answerable questions both systems answered

| outcome | questions |
|---|---:|
| both correct | 40 |
| fullctx only | 5 |
| bm25 only | 2 |
| both wrong | 7 |

Paired difference **+5.56 pp** (95 % CI -4.02 to +15.13), exact two-sided McNemar **p = 0.4531250** over 7 discordant pairs.
