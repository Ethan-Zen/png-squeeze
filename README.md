# png-squeeze

A lossless PNG squeezer written for make.fun's **Squeeze screenshots into the smallest PNG** bounty
(`png-squeeze-01-run-20261127`). It reads a set of 1280×720 screenshots and writes each one back,
pixel for pixel identical, in as few bytes as it can.

[![make.fun bounty](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)
[![rank](https://make.fun/badge/png-squeeze-01-run-20261127/Ethan-Zen/png-squeeze/rank.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)
[![reward](https://make.fun/badge/png-squeeze-01-run-20261127/Ethan-Zen/png-squeeze/reward.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)

Entered through make.fun — the bounty page is <https://make.fun/bounty/png-squeeze-01-run-20261127>
(referral code `rywn2b8e`).

## What it does

For every screenshot it picks the smallest colour type the pixels allow — grey (0), a palette with
`tRNS` (3), RGB (2) or RGBA (6) — orders palette entries so that neighbours in the picture get
neighbouring indices (a greedy walk over the pixel-adjacency graph, then swaps that shrink the
weighted spread), chooses the PNG row filter by measuring all five, and then writes the filtered
rows with its own DEFLATE encoder:

- **optimal parse** — a shortest-path search over the literal/match graph, with match lengths and
  distances costed from the Huffman table of the previous pass, re-run a few times until the parse
  stops improving;
- **dynamic Huffman blocks** — block boundaries are picked by encoded size, with the code lengths
  built by a heap Huffman and repaired to the 15-bit limit.

Nothing is lossy: every pixel's red, green, blue and alpha decode exactly as they went in, a fully
transparent pixel's colour too. The budget is counted in bytes rather than clock time, so two runs
of the same set produce byte-identical files.

## Run it

Node 22 (`main.ts` is plain JavaScript, run as TypeScript with the types stripped):

```sh
mkdir -p out
MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

By default it reads `/input/<id>/image.png` and writes `/output/<id>/image.png`, which is what the
grader uses.

## Measured on the kit's practice set

| instance | theme | bytes | make.fun scale | points |
| --- | --- | --- | --- | --- |
| i001 | flat | 11,776 | 13,547 | 754 |
| i002 | rich | 49,978 | 55,063 | 728 |
| i003 | alpha | 99,506 | 107,892 | 718 |
| i004 | grey | 101,943 | 110,521 | 718 |
| i005 | flat | 14,938 | 18,669 | 800 |
| i006 | rich | 170,649 | 185,295 | 719 |
| i007 | alpha | 58,770 | 64,285 | 724 |
| i008 | grey | 23,511 | 26,807 | 749 |

Score **738,831** of 1,000,000 on the practice set (each answer about `13×` smaller than the stored
input and `1.09×` smaller than make.fun's own scale compressor), all eight instances answered in the format the
checker reads.

## Licence

MIT — see [LICENSE](LICENSE).
