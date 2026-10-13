//! Preflight: what the hardware would mangle (errors), silently change
//! (warnings), or is merely worth knowing (infos). Every finding carries a
//! machine-applicable fix where the repair is unambiguous, so a UI can offer
//! one-click repairs and apply them through `apply_fix`.

use crate::abbrev;
use crate::model::*;
use crate::note::MAX_NOTE_ID;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

const KNOWN_PORT_MAX: i32 = 11; // MIDI 1-5, USB 1-6
const LEGAL_LABEL_CHARS: &str = "-()#. $@!&~%/+";

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Error,
    Warning,
    Info,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum FixOp {
    TruncateName { instrument: usize },
    ClampChannel { instrument: usize, to: i32 },
    ReduceSpread { instrument: usize, to: i32 },
    ClearSlot { instrument: usize, slot: u32 },
    SetTrackLabel { instrument: usize, slot: u32, label: String },
    SwapCcRange { instrument: usize, cc: i32 },
    ClampStart { instrument: usize, cc: i32, to: i32 },
}

impl FixOp {
    fn instrument_index(&self) -> usize {
        match self {
            FixOp::TruncateName { instrument }
            | FixOp::ClampChannel { instrument, .. }
            | FixOp::ReduceSpread { instrument, .. }
            | FixOp::ClearSlot { instrument, .. }
            | FixOp::SetTrackLabel { instrument, .. }
            | FixOp::SwapCcRange { instrument, .. }
            | FixOp::ClampStart { instrument, .. } => *instrument,
        }
    }
}

/// Where a finding lives in the editor, so a UI can jump straight to it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Area {
    Setup,
    Cc,
    Tv,
    Rows,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Finding {
    pub severity: Severity,
    pub instrument: String,
    /// Position in the library - names can be empty or duplicated, indices can't.
    pub index: usize,
    pub area: Area,
    pub title: String,
    pub detail: String,
    pub fix_label: Option<String>,
    pub fix: Option<FixOp>,
}

pub fn validate(library: &Library) -> Vec<Finding> {
    let mut findings = Vec::new();

    for (index, inst) in library.instruments.iter().enumerate() {
        check_name(index, inst, &mut findings);
        check_routing(index, inst, &mut findings);
        check_track_values(index, inst, &mut findings);
        check_cc_defs(index, inst, &mut findings);
        check_note_rows(index, inst, &mut findings);
    }
    check_shared_routing(library, &mut findings);
    check_duplicate_names(library, &mut findings);

    findings.sort_by_key(|f| f.severity);
    findings
}

pub fn has_errors(findings: &[Finding]) -> bool {
    findings.iter().any(|f| f.severity == Severity::Error)
}

pub fn apply_fix(library: &mut Library, fix: &FixOp) {
    let Some(inst) = library.instruments.get_mut(fix.instrument_index()) else { return };
    match fix {
        FixOp::TruncateName { .. } => {
            inst.name = inst.name.chars().take(MAX_NAME_LEN).collect();
        }
        FixOp::ClampChannel { to, .. } => {
            inst.midi_channel = *to;
        }
        FixOp::ReduceSpread { to, .. } => {
            inst.poly_spread = *to;
        }
        FixOp::ClearSlot { slot, .. } => {
            inst.track_values.remove(slot);
        }
        FixOp::SetTrackLabel { slot, label, .. } => set_track_label(inst, slot, label),
        FixOp::SwapCcRange { cc, .. } => swap_cc_range(inst, cc),
        FixOp::ClampStart { cc, to, .. } => clamp_start(inst, cc, *to),
    }
}

fn set_track_label(inst: &mut Instrument, slot: &u32, label: &str) {
    if let Some(TrackValue::MidiCc { label: l, .. }) = inst.track_values.get_mut(slot) {
        *l = Some(label.to_string());
    }
}

fn swap_cc_range(inst: &mut Instrument, cc: &i32) {
    if let Some(def) = inst.cc_defs.get_mut(cc) {
        std::mem::swap(&mut def.min, &mut def.max);
        def.start = def.start.clamp(def.min, def.max);
    }
}

fn clamp_start(inst: &mut Instrument, cc: &i32, to: i32) {
    if let Some(def) = inst.cc_defs.get_mut(cc) {
        def.start = to;
    }
}

pub fn summarize(inst: &Instrument) -> String {
    format!(
        "{}: name {}/{} · {} CC defs · {} of {} slots · {} note rows",
        inst.name,
        inst.name.chars().count(),
        MAX_NAME_LEN,
        inst.cc_defs.len(),
        inst.track_values.len(),
        TRACK_VALUE_SLOTS,
        inst.note_rows.len()
    )
}

// ---------------------------------------------------------------- checks

fn check_name(index: usize, inst: &Instrument, findings: &mut Vec<Finding>) {
    if inst.name.trim().is_empty() {
        findings.push(Finding {
            severity: Severity::Error,
            instrument: inst.name.clone(),
            index,
            area: Area::Setup,
            title: "Instrument has no name".into(),
            detail: "The Cirklon needs a name to list it. Give it one before exporting.".into(),
            fix_label: None,
            fix: None,
        });
        return;
    }
    if inst.name.chars().count() > MAX_NAME_LEN {
        let truncated: String = inst.name.chars().take(MAX_NAME_LEN).collect();
        findings.push(Finding {
            severity: Severity::Error,
            instrument: inst.name.clone(),
            index,
            area: Area::Setup,
            title: format!("Name \u{201c}{}\u{201d} won't fit", inst.name),
            detail: format!("Instrument names are {MAX_NAME_LEN} characters on the hardware."),
            fix_label: Some(format!("Use \u{201c}{truncated}\u{201d}")),
            fix: Some(FixOp::TruncateName { instrument: index }),
        });
    }
}

fn check_routing(index: usize, inst: &Instrument, findings: &mut Vec<Finding>) {
    if !(1..=16).contains(&inst.midi_channel) {
        let clamped = inst.midi_channel.clamp(1, 16);
        findings.push(Finding {
            severity: Severity::Error,
            instrument: inst.name.clone(),
            index,
            area: Area::Setup,
            title: format!("MIDI channel {} doesn't exist", inst.midi_channel),
            detail: "Channels run 1\u{2013}16.".into(),
            fix_label: Some(format!("Set channel {clamped}")),
            fix: Some(FixOp::ClampChannel { instrument: index, to: clamped }),
        });
    }

    if !(1..=KNOWN_PORT_MAX).contains(&inst.midi_port) {
        findings.push(Finding {
            severity: Severity::Warning,
            instrument: inst.name.clone(),
            index,
            area: Area::Setup,
            title: format!("Port {} is outside the editor's known range", inst.midi_port),
            detail: "MIDI 1\u{2013}5 and USB 1\u{2013}6 map to ports 1\u{2013}11. Higher numbers may be CV or USB-host ports - the editor can't verify them.".into(),
            fix_label: None,
            fix: None,
        });
    }

    if inst.poly_spread >= POLY_SPREAD_MIN {
        let top = inst.midi_channel + inst.poly_spread - 1;
        if top > 16 {
            let max_spread = 16 - inst.midi_channel + 1;
            let to = if max_spread >= POLY_SPREAD_MIN { max_spread } else { POLY_SPREAD_OFF };
            findings.push(Finding {
                severity: Severity::Error,
                instrument: inst.name.clone(),
                index,
                area: Area::Setup,
                title: "Poly spread runs past channel 16".into(),
                detail: format!(
                    "{} voices up from channel {} would need channel {top}.",
                    inst.poly_spread, inst.midi_channel
                ),
                fix_label: Some(if to == POLY_SPREAD_OFF {
                    "Turn spread off".into()
                } else {
                    format!("Reduce spread to {to}")
                }),
                fix: Some(FixOp::ReduceSpread { instrument: index, to }),
            });
        }
    }
}

fn check_track_values(index: usize, inst: &Instrument, findings: &mut Vec<Finding>) {
    let mut seen: HashMap<i32, u32> = HashMap::new();

    for (slot, tv) in &inst.track_values {
        let TrackValue::MidiCc { cc, label } = tv else { continue };

        if !(0..=127).contains(cc) {
            findings.push(Finding {
                severity: Severity::Error,
                instrument: inst.name.clone(),
                index,
                area: Area::Tv,
                title: format!("CC {cc} doesn't exist (slot {slot})"),
                detail: "CC numbers run 0\u{2013}127.".into(),
                fix_label: Some("Clear this slot".into()),
                fix: Some(FixOp::ClearSlot { instrument: index, slot: *slot }),
            });
            continue;
        }

        if let Some(first_slot) = seen.get(cc) {
            findings.push(Finding {
                severity: Severity::Error,
                instrument: inst.name.clone(),
                index,
                area: Area::Tv,
                title: format!("CC {cc} is mapped twice"),
                detail: format!(
                    "Slots {first_slot} and {slot} both claim it - the Cirklon will show two controls fighting over one parameter."
                ),
                fix_label: Some(format!("Keep slot {first_slot}, clear slot {slot}")),
                fix: Some(FixOp::ClearSlot { instrument: index, slot: *slot }),
            });
        } else {
            seen.insert(*cc, *slot);
        }

        if let Some(label) = label {
            check_label(index, inst, *slot, label, &format!("CC {cc}"), findings);
        }
    }
}

fn check_label(
    index: usize,
    inst: &Instrument,
    slot: u32,
    label: &str,
    owner: &str,
    findings: &mut Vec<Finding>,
) {
    if label.chars().count() > MAX_LABEL_LEN {
        let shipped: String = label.chars().take(MAX_LABEL_LEN).collect();
        let suggestion = abbrev::suggest(label);
        findings.push(Finding {
            severity: Severity::Warning,
            instrument: inst.name.clone(),
            index,
            area: Area::Tv,
            title: format!("\u{201c}{label}\u{201d} won't fit ({owner})"),
            detail: format!(
                "Labels are {MAX_LABEL_LEN} characters on the hardware - this ships as \u{201c}{shipped}\u{201d}."
            ),
            fix_label: Some(format!("Use \u{201c}{suggestion}\u{201d}")),
            fix: Some(FixOp::SetTrackLabel { instrument: index, slot, label: suggestion }),
        });
    } else if !label.chars().all(is_legal_label_char) {
        let cleaned: String = label.chars().filter(|c| is_legal_label_char(*c)).collect();
        findings.push(Finding {
            severity: Severity::Warning,
            instrument: inst.name.clone(),
            index,
            area: Area::Tv,
            title: format!("\u{201c}{label}\u{201d} has characters the Cirklon can't show ({owner})"),
            detail: format!("The hardware character set is letters, digits and {LEGAL_LABEL_CHARS}"),
            fix_label: Some(format!("Use \u{201c}{cleaned}\u{201d}")),
            fix: Some(FixOp::SetTrackLabel { instrument: index, slot, label: cleaned }),
        });
    }
}

fn is_legal_label_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || LEGAL_LABEL_CHARS.contains(c)
}

fn check_cc_defs(index: usize, inst: &Instrument, findings: &mut Vec<Finding>) {
    for def in inst.cc_defs.values() {
        if def.min > def.max {
            findings.push(Finding {
                severity: Severity::Error,
                instrument: inst.name.clone(),
                index,
                area: Area::Cc,
                title: format!("CC {} range is inverted ({}\u{2013}{})", def.cc, def.min, def.max),
                detail: "Minimum must not exceed maximum.".into(),
                fix_label: Some("Swap min and max".into()),
                fix: Some(FixOp::SwapCcRange { instrument: index, cc: def.cc }),
            });
        } else if def.start < def.min || def.start > def.max {
            let clamped = def.start.clamp(def.min, def.max);
            findings.push(Finding {
                severity: Severity::Error,
                instrument: inst.name.clone(),
                index,
                area: Area::Cc,
                title: format!(
                    "Start value {} is outside range {}\u{2013}{} on CC {}",
                    def.start, def.min, def.max, def.cc
                ),
                detail: "The hardware clamps silently.".into(),
                fix_label: Some(format!("Set start to {clamped}")),
                fix: Some(FixOp::ClampStart { instrument: index, cc: def.cc, to: clamped }),
            });
        }

        if def.label.is_empty() {
            findings.push(Finding {
                severity: Severity::Warning,
                instrument: inst.name.clone(),
                index,
                area: Area::Cc,
                title: format!("CC {} has no label", def.cc),
                detail: format!("It will show as \u{201c}cc# {}\u{201d} on the hardware.", def.cc),
                fix_label: None,
                fix: None,
            });
        }
    }
}

fn check_note_rows(index: usize, inst: &Instrument, findings: &mut Vec<Finding>) {
    for row in inst.note_rows.values() {
        if !(0..=MAX_NOTE_ID).contains(&row.note_id) {
            findings.push(Finding {
                severity: Severity::Error,
                instrument: inst.name.clone(),
                index,
                area: Area::Rows,
                title: format!("Note row {} is outside C0\u{2013}G10", crate::note::note_name(row.note_id)),
                detail: "The Cirklon's note range ends at G10 (\u{201c}G X\u{201d}). Remove or re-pitch this row.".into(),
                fix_label: None,
                fix: None,
            });
        }
    }
}

fn check_shared_routing(library: &Library, findings: &mut Vec<Finding>) {
    let mut by_route: HashMap<(i32, i32), Vec<(usize, &str)>> = HashMap::new();
    for (index, inst) in library.instruments.iter().enumerate() {
        by_route
            .entry((inst.midi_port, inst.midi_channel))
            .or_default()
            .push((index, &inst.name));
    }
    let mut routes: Vec<_> = by_route.into_iter().filter(|(_, sharers)| sharers.len() > 1).collect();
    routes.sort();
    for ((port, channel), sharers) in routes {
        let names: Vec<&str> = sharers.iter().map(|(_, name)| *name).collect();
        findings.push(Finding {
            severity: Severity::Info,
            instrument: names[0].to_string(),
            index: sharers[0].0,
            area: Area::Setup,
            title: format!("Port {port} \u{b7} ch {channel} is shared"),
            detail: format!(
                "\u{201c}{}\u{201d} all send here. Fine if intentional - consider Multi-timbral if it's one box.",
                names.join("\u{201d}, \u{201c}")
            ),
            fix_label: None,
            fix: None,
        });
    }
}

fn check_duplicate_names(library: &Library, findings: &mut Vec<Finding>) {
    let mut holders: HashMap<&str, Vec<usize>> = HashMap::new();
    for (index, inst) in library.instruments.iter().enumerate() {
        if !inst.name.is_empty() {
            holders.entry(inst.name.as_str()).or_default().push(index);
        }
    }
    let mut dupes: Vec<_> = holders.into_iter().filter(|(_, at)| at.len() > 1).collect();
    dupes.sort();
    for (name, at) in dupes {
        findings.push(Finding {
            severity: Severity::Error,
            instrument: name.to_string(),
            index: at[1], // the later one is the one to rename
            area: Area::Setup,
            title: format!("Two instruments are named \u{201c}{name}\u{201d}"),
            detail: "The Cirklon looks instruments up by name - the second one would replace the first on load.".into(),
            fix_label: None,
            fix: None,
        });
    }
}
