//! The IPC seam: exactly the JSON shapes the frontend (ui/app.js) constructs
//! must deserialize into the model, and what the model serializes must be what
//! the frontend reads. If app.js changes its object shapes, change them here too.

use cirklon_core::model::*;
use cirklon_core::validate::{self, FixOp};

/// A new instrument exactly as ui/app.js newInstrument() builds it.
#[test]
fn frontend_new_instrument_deserializes() {
    let js = r#"{
      "name": "New inst", "midi_port": 1, "midi_channel": 1,
      "default_note": 36, "default_pattern": "Sel",
      "multi": false, "poly_spread": 0, "no_xpose": false, "no_fts": false,
      "no_thru": false, "no_bank_m": false, "no_bank_l": false,
      "show_note_nums": false, "presend_pgm": false,
      "track_values": {}, "cc_defs": {}, "note_rows": {}
    }"#;
    let inst: Instrument = serde_json::from_str(js).expect("frontend shape deserializes");
    assert_eq!(inst.default_pattern, PatternType::Sel);
    assert_eq!(inst.default_note, Some(36));
}

/// Track values as the frontend writes them: string slot keys, tagged kinds,
/// kebab-case control ids matching the CONTROLS table in app.js.
#[test]
fn frontend_track_values_deserialize() {
    let js = r#"{
      "1": { "kind": "Control", "control": "pgm" },
      "2": { "kind": "MidiCc", "cc": 74, "label": "cutoff" },
      "3": { "kind": "MidiCc", "cc": 7, "label": null },
      "4": { "kind": "Control", "control": "fts-r" },
      "5": { "kind": "Control", "control": "note-pct" },
      "6": { "kind": "Control", "control": "reich" }
    }"#;
    let tvs: std::collections::BTreeMap<u32, TrackValue> =
        serde_json::from_str(js).expect("track values deserialize");
    assert!(matches!(tvs[&1], TrackValue::Control { control: TrackControl::Pgm }));
    assert!(matches!(tvs[&4], TrackValue::Control { control: TrackControl::FtsR }));
    assert!(matches!(tvs[&5], TrackValue::Control { control: TrackControl::NotePct }));
    assert!(matches!(&tvs[&3], TrackValue::MidiCc { label: None, .. }));
}

/// Every control's serde id must match app.js's CONTROLS table.
#[test]
fn control_serde_ids_match_frontend_table() {
    let expected = [
        "pgm", "quant", "note-pct", "note-c", "velo-pct", "velo-c", "leng-pct",
        "tbase", "xpos", "octave", "knob1", "knob2", "fts-r", "fts-s", "reich",
    ];
    for (control, expected_id) in TrackControl::ALL.iter().zip(expected) {
        let json = serde_json::to_value(control).unwrap();
        assert_eq!(json.as_str().unwrap(), expected_id, "serde id for {control:?}");
    }
}

/// Findings serialize with lowercase severities and tagged fix ops the
/// frontend can send straight back into apply_fixes.
#[test]
fn findings_round_trip_through_json() {
    let mut inst = Instrument::new("Grandmother!");
    inst.track_values.insert(2, TrackValue::MidiCc { cc: 74, label: None });
    inst.track_values.insert(5, TrackValue::MidiCc { cc: 74, label: None });
    let mut lib = Library { instruments: vec![inst] };

    let findings = validate::validate(&lib);
    let json = serde_json::to_string(&findings).unwrap();
    assert!(json.contains("\"severity\":\"error\""));
    assert!(json.contains("\"op\":\"clear_slot\"") || json.contains("\"op\":\"truncate_name\""));

    // frontend sends the fix objects back verbatim
    let parsed: Vec<validate::Finding> = serde_json::from_str(&json).unwrap();
    let fixes: Vec<FixOp> = parsed.into_iter().filter_map(|f| f.fix).collect();
    assert!(!fixes.is_empty());
    for fix in &fixes {
        validate::apply_fix(&mut lib, fix);
    }
    assert!(validate::validate(&lib).is_empty());
}

/// Findings tell the frontend where to jump: an instrument index plus one of
/// app.js's tab ids ("setup" | "cc" | "tv" | "rows").
#[test]
fn findings_carry_a_jump_target() {
    let mut drums = Instrument::new("Drums");
    drums.cc_defs.insert(7, CcDef::new(7)); // unlabeled -> warning on the CC map
    drums.track_values.insert(1, TrackValue::MidiCc { cc: 200, label: None }); // -> error on track values
    let lib = Library { instruments: vec![Instrument::new("Bass"), drums, Instrument::new("Bass")] };

    let json = serde_json::to_value(validate::validate(&lib)).unwrap();
    let target = |needle: &str| {
        let f = json.as_array().unwrap().iter()
            .find(|f| f["title"].as_str().unwrap().contains(needle))
            .unwrap_or_else(|| panic!("no finding titled {needle}"));
        (f["index"].as_u64().unwrap(), f["area"].as_str().unwrap().to_string())
    };
    assert_eq!(target("has no label"), (1, "cc".into()));
    assert_eq!(target("doesn't exist"), (1, "tv".into()));
    assert_eq!(target("Two instruments are named"), (2, "setup".into()), "points at the later duplicate");
}

/// The merge_sidecar command's data path: two frontend-shaped sidecars in,
/// incoming values fill gaps but never blank what the user already wrote.
#[test]
fn frontend_sidecar_merge() {
    let mut target: cirklon_core::ckix::Sidecar = serde_json::from_str(r#"{
      "Moog": { "notes": "keep me", "cc_meta": { "74": { "name": "Cutoff" } } },
      "Sub 37": { "notes": "v1", "cc_meta": {} }
    }"#).expect("target deserializes");
    let incoming: cirklon_core::ckix::Sidecar = serde_json::from_str(r#"{
      "Moog": { "notes": "", "cc_meta": { "74": { "desc": "24 dB lowpass" }, "71": { "name": "Resonance" } } },
      "Sub 37": { "notes": "v2" },
      "DX7": { "notes": "algo 5" }
    }"#).expect("incoming deserializes");

    cirklon_core::ckix::merge(&mut target, &incoming);

    assert_eq!(target["Moog"].notes, "keep me", "empty incoming notes never blank existing");
    assert_eq!(target["Sub 37"].notes, "v2", "non-empty incoming overwrites");
    assert_eq!(target["Moog"].cc_meta[&74].name, "Cutoff");
    assert_eq!(target["Moog"].cc_meta[&74].desc, "24 dB lowpass");
    assert_eq!(target["Moog"].cc_meta[&71].name, "Resonance");
    assert_eq!(target["DX7"].notes, "algo 5");
}

/// Sidecar as the frontend mutates it: empty strings and sparse cc_meta
/// objects must serialize cleanly and drop empties.
#[test]
fn frontend_sidecar_shapes() {
    let js = r#"{
      "Sub 37": { "notes": "", "cc_meta": { "19": { "name": "Filter Cutoff" } } },
      "Empty": { "notes": "", "cc_meta": {} }
    }"#;
    let sidecar: cirklon_core::ckix::Sidecar = serde_json::from_str(js).expect("sidecar deserializes");
    assert_eq!(sidecar["Sub 37"].cc_meta[&19].name, "Filter Cutoff");
    assert_eq!(sidecar["Sub 37"].cc_meta[&19].desc, "", "missing fields default");
    assert!(sidecar["Empty"].is_empty());

    let out = cirklon_core::ckix::serialize(&sidecar);
    assert!(!out.contains("Empty"), "empty instruments are dropped on write");
}
