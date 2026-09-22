# Provider migration measurements

## Parallel large-history processing

`parallel-final.json` compares the preceding optimized standalone build with the
parallel scanner/catalog/copier. Five trials alternate build order, use a warm OS
cache, and include process startup. Plans and byte-exact round trips match.

| Case | Before | After |
| --- | ---: | ---: |
| Plan one 1 GiB history | 315 ms | 152 ms |
| Rewrite that history | 1,216 ms | 853 ms |
| Equal-length migration of that history | 382 ms | 211 ms |
| Plan a 1 GiB history with damaged ordinal-based indices | 602 ms | 275 ms |
| Read 2054-file catalog and plan one selected family | 182 ms | 107 ms |
| Rewrite a balanced 1 GiB / 32-file batch | 621 ms | 624 ms |
| Equal-length migration of the balanced batch | 162 ms | 161 ms |

Balanced batches show no material change. The improvements are concentrated in
large individual histories and catalog lookups, not a universal multiplier.
The real-data read-only comparison is in `parallel-live-readonly.json`; its source
files and provider/configuration settings are never modified by the benchmark.

The scanner and ordinal repair share record-aligned partitions, tested at every
boundary of a Unicode/CRLF fixture, including duplicate ordinal rejection. A large
single JSON record stays intact. Normal scanning uses 8 MiB chunks for files of at
least 64 MiB; 4–64 MiB tuning results are recorded in the report. The bounded worker
pool is shared rather than creating another pool for each file.

`mapped-copy-experiment.json` and `copy-threshold.json` compare streamed and mapped
copying. Mapping improves dominant large files but slows a balanced small-file batch.
The production choice therefore requires both at least 64 MiB and at least half the
batch's rewritten bytes. The mapped file is newly created, disjoint mutable chunks
preserve every byte, and both mapping flush and file synchronization precede commit.
Both copy paths pass the 36 error/crash scenarios, exact round trips and native
backend resume/edit/archive tests; the mapped path is forced on small fixtures too.

```powershell
python benchmark_provider_parallel.py --before PATH_TO_OLD_TEST_EXE --after PATH_TO_NEW_TEST_EXE --trials 5
python benchmark_provider_parallel.py --before PATH_TO_OLD_EXE --after PATH_TO_NEW_EXE --audit-home CODEX_HOME_PATH --trials 3 --output benchmarks/provider-migration/parallel-live-readonly.json
```

## Additional standalone optimizations

`optimization.json` compares the saved previous standalone executable with the
optimized build, alternating execution order over five warm-cache trials. Timings
include process startup. All data is disposable; plans and exact round trips match.

| Complete operation | Before | After |
| --- | ---: | ---: |
| Plan one family; 250,000 unrelated rows in each indexed history table | 78.8 ms | 28.6 ms |
| Same data, without a `thread_turns` index | 78.3 ms | 38.9 ms |
| Migrate a family with 10,000 additional selected index rows | 118.3 ms | 87.7 ms |
| Rewrite 1 GiB / 32 files / 16 workers | 635.8 ms | 597.3 ms |
| Equal-length migration of the same histories | 166.0 ms | 159.6 ms |

The large-index gain is repeatable across these samples. Rewrite measurements have
visible variance; their modest median difference is not a guaranteed speedup.
The builds are identified by SHA-256 in the report. Reproduce with two separately
built `test-harness` executables:

```powershell
python benchmark_provider_optimization.py --before PATH_TO_OLD_EXE --after PATH_TO_NEW_EXE --trials 5
```

Changes remove unrelated index rows from the Rust/SQLite boundary, redundant header
opens, per-row SELECT-before-UPDATE calls, repeated SQL construction, and re-reading
the committed journal on normal success. UI changes cache search text/results and
write only changed terminal rows; those are not included in CLI migration timings.
Catalog reconstruction before writing, history validation, fsync, and crash recovery
remain in place. Physical I/O and required validation still impose a lower bound.

Validation passes exact round trips, 36 injected error/crash cases, and conditional
index-update checks for NULLs, missing rows and external changes. Native backend
testing initially failed once at `thread/unarchive` with `no archived rollout found`.
The subsequent recorded comparison passed 12 runs per build; the initial failure's
cause remains unestablished. `native-repeat.json` preserves both that failure and
the 24 subsequent results rather than treating the retries as proof it cannot recur.

## Standalone Rust application

`standalone-final.json` compares the complete standalone process with the Python/Rust
hybrid on 1 GiB / 32 disposable files, five warm-cache trials. Both use the optimized
Rust scanner/copier. The standalone times include executable startup; the hybrid
times start inside an already-running Python interpreter.

| Complete operation, 16 workers | Hybrid | Standalone |
| --- | ---: | ---: |
| Growing/shrinking fields | 0.617 s | 0.626 s |
| Equal-length fields | 0.262 s | 0.166 s |

Rewrite throughput is effectively unchanged at this scale; equal-length migration
is about 1.58 times faster. `standalone-32-workers.json` measures 0.672 s rewrite and
0.165 s equal-length: 32 workers add no useful overall gain. Default: up to 16.
These are measured results, not a claim that all hardware bottlenecks disappear.

Removed overhead includes the Python process dependency, JSON/base64 IPC for the
whole migration plan, repeated schema queries, repeated parent-file opens, a second
marker-search pass, an intermediate read buffer, and serial waits for independent
file writes. Validation, fsync and recovery are retained.

`copy-comparison.json` compares buffered vs memory-mapped copying inside the same
standalone build: 0.647 vs 0.585 s median complete rewrite at eight workers.
The manual scanner microbenchmark measured 0.009676 vs 0.004760 s per 256 MiB
for two memmem passes vs one regex pass. Reproduce it with:

```powershell
cargo test --release --manifest-path provider_migrate_rs/Cargo.toml marker_search -- --ignored --nocapture
python benchmark_provider_standalone.py --trials 5 --workers 8 16 32
```

`standalone-live-readonly.json` verifies identical complete file/index plans against
Python for 853 stable real files / 29,889,196,323 bytes: 3.047 s standalone process
vs 5.779 s Python planning, including 38 stale index rows. Recently active families
are excluded. These are read-only planning times, not migration times.

## Reference hybrid measurements

Environment: Windows, Ryzen 9 9950X3D (16 cores / 32 logical processors), about
62 GiB usable RAM, Samsung NVMe SSDs. Synthetic data fits in the OS file cache.
These are warm-cache measurements, not cold-disk guarantees.

`provider-benchmark-final.json` contains five repetitions on approximately 1 GiB
across 32 synthetic JSONL files. The same selected families, offsets, transaction
coordinator and durability checks are used for both processing engines. Timings
include scanning, preparing files, fsync, index/config commits and journal cleanup.
Round trips are checked with SHA-256 against the original files.

| Operation, 8 workers | Python | Rust processing engine |
| --- | ---: | ---: |
| Scan only | 0.248 s | 0.108 s |
| Complete migration, growing/shrinking fields | 0.780 s | 0.620 s |
| Complete migration, equal-length fields | 0.384 s | 0.248 s |

The Rust path retains Python for the UI, catalog, index reconciliation and
transaction coordinator. These results do not describe a standalone all-Rust CLI.

Optimizations evaluated:

- C-backed marker search instead of parsing/reserializing every conversation record.
- One regex pass versus two `mmap.find` passes in Python: regex won on the tested data.
- Threads versus processes for Python scanning: processes won for large inputs;
  small inputs retain threads to avoid Windows process startup overhead.
- 1, 4, 8, 16 and 32 workers: eight gave the best measured overall results.
  At 32 workers, complete rewrite migration slowed to 0.861 s for Python and
  0.754 s for Rust. Loading every logical processor did not improve throughput.
- Native parallel search and buffered copying in Rust, preserving the same patch plan.
- Equal-length writes avoid a full file rewrite; unequal-length writes copy untouched
  byte ranges without JSON reserialization. No provider aliases or padding are used.
- History dependencies are processed in topological order; offsets use physical IDs.

`provider-live-readonly-audit.json` records a separate **read-only** comparison:
829 stable files, 29,114,816,301 bytes, 96 families. Python and Rust produced identical
patch plans in 3.988 s and 2.193 s respectively; index verification took another
0.135 s. Thirty-eight stale index rows were resolved from ordinals in the plan.
No user histories, indices or configuration were changed by this audit. Recently
modified families were omitted to avoid racing active tasks. This is planning time,
not the time required to rewrite that dataset.

Reproduce synthetic results from the repository root:

```powershell
python benchmark_provider_migration.py --mib 1024 --trials 5 --workers 8 32 --output benchmark-local.json
```

The remaining JSON reports retain concurrency and search-strategy measurements.
They are empirical comparisons, not proof of an absolute theoretical speed limit.

## Cross-platform validation

`cross-platform-validation.json` records native Windows and macOS/APFS checks.
The Intel macOS build was executed through Rosetta on Apple Silicon, not on a
physical Intel Mac. Both macOS architectures passed the same standalone tests,
including terminal interaction, and migration acceptance with a real Codex backend
using loopback model responses. No user histories were migrated.

`windows-platform-parity.json` compares the Windows build before and after the OS
split, with five alternating trials and identical plan/round-trip checks. The
measured medians differ by less than 1.6% across the tested cases; no material
performance regression was observed. One 1 GiB rewrite measured 0.838 s before and
0.844 s after; the balanced 32-file rewrite measured 0.629 s and 0.619 s.
