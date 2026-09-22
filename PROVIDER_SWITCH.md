# Codex provider switcher

On Windows, run `Codex Provider Switcher.exe` or its `.cmd` shortcut.
The macOS universal binary contains Apple Silicon and Intel builds.
The executable contains the Rust application and SQLite; Windows also links the
C runtime statically. Python, Node, Cargo and a separate SQLite installation are
not required to use it. macOS uses the operating system's native libraries.

On macOS, the installed command is `codex-provider-switcher`. The executable is
in `~/.local/bin`; it opens in the current terminal and uses the terminal's colors.

The two sections are **Conversations** and **Providers**; `Tab` switches between
them. Both support keyboard navigation, mouse selection and paste-to-search.

**Conversations:** search names, projects or IDs, including related records.
Search ignores case, separators and the difference between Russian е/ё:
`SVG1` also finds `SVG 1` and `SVG-1`. Multiple words can appear in any order,
so `обучение SVG1` finds `SVG 1 новое обучение`. The search index is built once
when the list loads; typing does not rescan histories.
Results show the matching conversation name within a family, rather than hiding
it behind the root's name. Related branches, agents and archived records switch
with the selected conversation. Images retain their content and ownership.
Each result shows its provider in an aligned column, or on a second line in
narrow terminals. `Mixed` means related conversations use different providers.
Long labels end in `…`. Arrow keys and the mouse wheel move one result at a time;
the viewport follows one row at its edge. Page Up and Page Down are unused.
Space toggles the highlighted conversation; clicking its checkbox does the same.
Select all applies to the current search and archive view; Clear selection removes
all selections. With no checkmarks, **Change provider (0)** is disabled; Enter opens
the highlighted conversation directly. With exactly one checkmark, Enter opens
that marked conversation; with multiple checkmarks, use Change provider.
Its current provider is initially highlighted
in color. Arrow keys move only the pointer; Enter or a mouse click selects a
provider and moves the colored highlight. Apply uses that explicit selection even
if the pointer later moves elsewhere. The global
default is shown only in Providers. After selection, Right arrow focuses
**Change provider (N)** below the list.
Up/Down chooses an action, Enter runs it, and Left or Escape returns to the list
without losing selection or position. Conversation switching never changes the
global default. Close Codex Desktop and CLI before applying conversation changes.

Both tab names remain visible; color indicates the current section. Tab switches
main sections. Escape returns from search or actions to the list, or from a nested
screen to its parent. It preserves search text and never exits the main screen.
Nested screens have a parent chain, not a history of repeated visits. Ctrl+C exits;
a write already in progress must finish or be recovered before leaving.

**Providers:** `openai` is always available. **Add provider** saves a connection
without changing conversations or the current default. **Use as default** changes
only the default for new conversations, without a second confirmation screen. Existing
connections remain selectable and their definitions are preserved. Adding from
the conversation picker returns to that picker after saving.

In the connection form, Tab/Shift+Tab moves between fields and buttons. Text fields
support cursor movement, Home/End, Delete, Backspace and paste. Supply a Responses
API base URL and paste your API key. Key input is masked and saved directly in
the provider's local `config.toml` entry. The Authentication control also offers
an environment variable (enter its name; its value must be available to Codex)
or no authentication for servers that do not require a key. Changing the
authentication mode clears the credential field. Validation is local and does not test credentials or send
model requests. Errors preserve the entered values for correction and retry.

Connection-only changes use an atomic config write and never open conversation
databases or histories. An unfinished migration blocks configuration writes until
recovery. Conversation migrations retain their recoverable transaction; conversation-only switching leaves config.toml byte-for-byte unchanged. Errors remain
on the provider picker, with Apply available for an explicit retry.

The Python implementation remains as an independently checked reference for tests
and benchmarks. The executable does not invoke it or another processing binary.
Concurrency defaults to up to 16 workers; `--workers` can override it. The measured
32-worker case did not improve complete rewrite throughput.

Search text is prepared once per catalog load; filtered results are reused during
navigation. The terminal writes only changed rows and ignores key-release events.
Before migration, the catalog is read again to detect new or changed relatives.
SQLite selects only the relevant physical histories using its existing indexes;
index validation and update use a single conditional statement per row. Completed
transactions clean up from their validated in-memory journal, while recovery after
interruption still reads and validates the saved journal. Durable writes remain.

Canonical path checks run in parallel. Files of at least 64 MiB are scanned in
record-aligned chunks, including scans needed to repair ordinal-based indices.
The same bounded worker pool handles both file-level and within-file work.
For rewriting, a file of at least 64 MiB that accounts for half or more of the
batch uses parallel copying into an exclusively created mapped staging file.
Balanced batches use streamed copies. Both paths flush and synchronize the file
before replacing any history. No persistent metadata cache is trusted instead of
reading the current files and relations.

```powershell
# Run from the repository root (Rust 1.96+ and MSVC development tools).
cargo build --release --manifest-path provider_migrate_rs/Cargo.toml
Copy-Item provider_migrate_rs/target/release/provider-migrate.exe 'Codex Provider Switcher.exe'

# Read-only listing or planning using the standalone application.
& '.\Codex Provider Switcher.exe' --list
& '.\Codex Provider Switcher.exe' --audit --all --provider factory
```

Build the macOS universal binary on a Mac with Rust 1.96+ and Xcode command-line tools:

```sh
rustup target add aarch64-apple-darwin x86_64-apple-darwin
for target in aarch64-apple-darwin x86_64-apple-darwin; do
    cargo build --locked --release --target "$target" --manifest-path provider_migrate_rs/Cargo.toml || exit
done
lipo -create provider_migrate_rs/target/aarch64-apple-darwin/release/provider-migrate \
    provider_migrate_rs/target/x86_64-apple-darwin/release/provider-migrate \
    -output codex-provider-switcher
mkdir -p "$HOME/.local/bin"
install -m 755 codex-provider-switcher "$HOME/.local/bin/codex-provider-switcher"
codex-provider-switcher --list
```

Both systems compile the same catalog, search, scanner, copy engine, index repair
and transaction coordinator. Only `src/platform.rs` and `src/platform/` select OS
operations at compile time. No runtime adapter processes are launched. macOS uses
native process enumeration, filesystem mount information and Unix metadata; Windows
retains its native process snapshot and file operations. Parallelism, chunk sizes,
mapped copying and selective SQLite queries are shared without fallback algorithms.

The root `model_provider` in `config.toml` is changed along with selected families;
models, provider definitions, credentials, permissions and instructions are retained.
`CODEX_HOME` selects the data directory; the default is `.codex` in the user's home
directory on either OS. `--home` overrides it. `sqlite_home` in the config takes precedence
over `CODEX_SQLITE_HOME`, followed by the Codex home directory, matching the tested backend.

## Storage and recovery

The implementation targets the plain paginated history contract of Codex
`0.154.0-alpha.6.2`, checked against
[the matching backend source](https://github.com/openai/codex/tree/b5bffd3ec4db487e7e3dec59663875b0ef7b72ca/codex-rs/thread-store/src).
Unsupported history formats and ambiguous relationships are rejected before writing.
This is an offline utility; changes to a running Codex session are not supported.
Process checks include the CLI, desktop and separately named agent backends;
failure to inspect a process blocks writing. Keep Codex closed throughout migration.

macOS staging files and transaction journals start with private Unix permissions;
replacement histories and configuration preserve the source file's Unix mode.
File flushes use Rust's native Apple synchronization, directory entries are synced
after rename/unlink, and SQLite enables `fullfsync` and `checkpoint_fullfsync`.
Space checks use the filesystem containing the histories, including separate mounts.

Migration changes `threads.model_provider`, `session_meta.payload.model_provider`,
and persisted `thread_settings_applied.thread_settings.model_provider_id` values.
All unrelated JSONL bytes are retained. Equal-length fields are patched in place;
files that grow or shrink are streamed once into a sibling staging file using a
read-only memory map, without a separate read buffer. No aliases
or whitespace padding are introduced.

Byte offsets are reconciled by **physical rollout ID**, including superseded files
created by message editing. `history_base` cutoffs, turn boundaries and projection
checkpoints are updated together. Existing inconsistent offsets are resolved from
their stored ordinals; missing or ambiguous evidence aborts the operation.

The temporary `.provider-switch.pending.json` journal and sibling staging files
make interrupted writes recoverable. Original rewritten files are retained by rename
until both databases and the config are committed. They are removed on completion;
no permanent history backups are created. The standalone executable can recover
the previous Python utility's version 2/3 journals as well as its own version 4.
After interruption, run the switcher again
with Codex closed and accept recovery before opening Codex. Do not manually delete
pending transaction files. Changed external data blocks automatic recovery.

## Verification

```powershell
python switch_codex_provider.py --self-test
python benchmark_provider_migration.py --mib 1024 --trials 5 --workers 8
cargo clippy --manifest-path provider_migrate_rs/Cargo.toml --all-targets --all-features -- -D warnings
cargo test --manifest-path provider_migrate_rs/Cargo.toml

# Separate test-only build: permits local fixtures while the user's Codex is open.
# Never distribute this build. The normal executable contains no such bypass.
cargo build --release --features test-harness --target-dir provider_migrate_rs/target-test --manifest-path provider_migrate_rs/Cargo.toml
python test_provider_standalone.py
python test_provider_native.py --engine standalone
python benchmark_provider_standalone.py --trials 5 --workers 8 16
```

The native test creates a disposable Codex home and a loopback Responses server.
It exercises a real root task, an archived fork, a real V2 subagent, edits before
and after migration, stale-index repair and repeated cold resumes. Model responses
come only from the local fixture server. The standalone regression checks also
cover exact patch/index plan parity, round trips, injected errors and process crashes,
recovery of older journals, process/lock guards, and unsupported formats.
The selected installed Codex binary can be
specified with `--exe`.
The same regression commands run on macOS with Python 3.11+ for development tests.
They additionally exercise Unix permissions, hard links and the actual terminal
through a PTY. `PROVIDER_TEST_BINARY` and `PROVIDER_PRODUCTION_BINARY` can select
architecture-specific builds for tests; these variables are not application settings.

Benchmarks use synthetic histories, compare identical patch plans and verify byte
identity after round trips. Timings include fsync, database commits, config writes
and journal cleanup. Reported warm-cache results must not be interpreted as cold-disk
or full-user-dataset migration timings. See `benchmarks/provider-migration/` for
measurements and the comparison.
