<div align="center">

# Cirklon 2 Desktop App

**Instrument definitions for the Sequentix Cirklon — described like a synth manual, shipped like the hardware wants them.**

[![firmware](https://img.shields.io/badge/CirkOS-1.22-F0A63C)](https://www.sequentix.com/cirklon-downloads)
[![format](https://img.shields.io/badge/.CKI-Cirklon%201%20%2B%202-1C1F24)](app/core/src/cki.rs)
[![built with](https://img.shields.io/badge/Rust%20%2B%20Tauri-~2.5%20MB%20app-2E333A)](app/)
[![tests](https://img.shields.io/badge/cirklon--core-27%20passing-2a7d4f)](app/core/tests/)

</div>

## Why

The Cirklon stores **six characters per control**. Your synth's filter cutoff deserves more than `FltCut` — so this editor keeps the full name, range, and your notes for every CC, and ships the hardware exactly its six characters. Paste rows straight from a MIDI implementation chart (`19 Filter Cutoff 0-127`) and labels are abbreviated for you; the documentation lives in a `.ckix` sidecar next to each export and merges back by CC number on import, so a round-trip through the hardware never costs you what you wrote down.

## What you get

Track values are arranged in **rows of exactly six** — the same six slots above six encoders the Cirklon shows — with drag-to-move between slots and a character-true preview of the TRACK screens you'll see on stage. Before anything reaches an SD card, **preflight** catches what the hardware would silently mangle (duplicate CCs, over-long labels, poly-spread past channel 16, clashing routings), each finding with a one-click fix; errors block export, warnings ship knowingly. Supports every instrument-definition feature of CirkOS 1.22 on both Cirklon 1 and 2 — including `no_thru`, bank-select flags, `presend_pgm`, 180 track-value slots, and `default_note: off` — plus drum-grid note rows.

## Run it

Grab the build for your OS from **[Releases](../../releases)** — a ~2.5 MB `.dmg` (macOS universal), `-setup.exe` (Windows), or `.AppImage` (Linux). Builds are unsigned, so on first launch: macOS right-click → *Open*, Windows *More info → Run anyway*. From source: `cd app && cargo tauri dev`. The format engine is a pure-Rust crate ([`cirklon-core`](app/core/)) whose test suite round-trips real firmware files — and was verified byte-equivalent to an independent C# implementation before that reference was retired (see git history ≤ `30a843a`). Releases are cut from a `v*` tag ([docs/RELEASING.md](docs/RELEASING.md)).

---

Began as a fork of [dyskotron/CKIEditor](https://github.com/dyskotron/CKIEditor), a Unity editor for the same format — extended for CirkOS 1.22, then rewritten in Rust + Tauri. The Unity lineage lives in this repo's history.
