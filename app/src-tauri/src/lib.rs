//! Thin Tauri shell over cirklon-core. All state lives in the frontend;
//! commands are pure functions plus file I/O, so everything stays testable
//! in the core crate.

use cirklon_core::chart::ChartEntry;
use cirklon_core::ckix::{self, Sidecar};
use cirklon_core::model::Library;
use cirklon_core::validate::{self, Finding, FixOp};
use cirklon_core::{abbrev, cki};
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::Manager;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

#[derive(Serialize)]
struct LoadResult {
    library: Library,
    sidecar: Sidecar,
    path: String,
}

#[tauri::command]
fn load_library(path: String) -> Result<LoadResult, String> {
    let text = std::fs::read_to_string(&path).map_err(|e| format!("can't read {path}: {e}"))?;
    let library = cki::parse(&text)?;

    let sidecar_path = ckix::sidecar_path(&path);
    let sidecar = std::fs::read_to_string(&sidecar_path)
        .map(|t| ckix::parse(&t))
        .unwrap_or_default();

    Ok(LoadResult { library, sidecar, path })
}

#[derive(Serialize)]
struct SaveResult {
    cki_path: String,
    ckix_path: Option<String>,
}

#[tauri::command]
fn save_library(path: String, library: Library, sidecar: Sidecar) -> Result<SaveResult, String> {
    std::fs::write(&path, cki::serialize(&library)).map_err(|e| format!("can't write {path}: {e}"))?;

    // only ship sidecar entries for instruments in this export
    let exported: Sidecar = sidecar
        .into_iter()
        .filter(|(name, meta)| !meta.is_empty() && library.instruments.iter().any(|i| &i.name == name))
        .collect();

    let ckix_path = if exported.is_empty() {
        None
    } else {
        let sp = ckix::sidecar_path(&path);
        std::fs::write(&sp, ckix::serialize(&exported)).map_err(|e| format!("can't write {sp}: {e}"))?;
        Some(sp)
    };

    Ok(SaveResult { cki_path: path, ckix_path })
}

#[tauri::command]
fn validate_library(library: Library) -> Vec<Finding> {
    validate::validate(&library)
}

#[tauri::command]
fn apply_fixes(mut library: Library, fixes: Vec<FixOp>) -> Library {
    for fix in &fixes {
        validate::apply_fix(&mut library, fix);
    }
    library
}

#[tauri::command]
fn merge_sidecar(mut target: Sidecar, incoming: Sidecar) -> Sidecar {
    ckix::merge(&mut target, &incoming);
    target
}

#[tauri::command]
fn parse_chart(text: String) -> Vec<ChartEntry> {
    cirklon_core::chart::parse(&text)
}

#[tauri::command]
fn suggest_label(name: String) -> String {
    abbrev::suggest(&name)
}

/// True while the frontend holds edits that haven't been exported.
#[derive(Default)]
struct Unsaved(AtomicBool);

#[tauri::command]
fn set_dirty(dirty: bool, unsaved: tauri::State<Unsaved>) {
    unsaved.0.store(dirty, Ordering::Relaxed);
}

/// The frontend holds the only copy of unexported edits, so closing asks first.
fn guard_close(window: &tauri::Window, event: &tauri::WindowEvent) {
    let tauri::WindowEvent::CloseRequested { api, .. } = event else { return };
    if !window.state::<Unsaved>().0.load(Ordering::Relaxed) {
        return;
    }
    api.prevent_close();
    let closing = window.clone();
    window
        .dialog()
        .message("Edits since the last export will be lost.")
        .title("Close without exporting?")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom("Discard edits".into(), "Keep editing".into()))
        .parent(window)
        .show(move |discard| {
            if discard {
                let _ = closing.destroy();
            }
        });
}

/// The stock macOS Quit item terminates the process without a close request,
/// which would skip `guard_close` - swap it for one that closes the window.
#[cfg(target_os = "macos")]
mod guarded_quit {
    use tauri::menu::{Menu, MenuEvent, MenuItem, MenuItemKind};
    use tauri::{AppHandle, Manager, Wry};

    const QUIT_ID: &str = "guarded-quit";

    pub fn menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
        let menu = Menu::default(app)?;
        if let Some(MenuItemKind::Submenu(app_menu)) = menu.items()?.into_iter().next() {
            if let Some(MenuItemKind::Predefined(stock_quit)) = app_menu.items()?.last() {
                app_menu.remove(stock_quit)?;
                let label = format!("Quit {}", app.package_info().name);
                app_menu.append(&MenuItem::with_id(app, QUIT_ID, label, true, Some("Cmd+Q"))?)?;
            }
        }
        Ok(menu)
    }

    pub fn on_event(app: &AppHandle, event: MenuEvent) {
        if event.id() == QUIT_ID {
            for window in app.webview_windows().values() {
                let _ = window.close();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cirklon_core::ckix::InstrumentMeta;

    /// Direction matters: incoming overwrites target, and target-only entries survive.
    #[test]
    fn merge_sidecar_merges_incoming_into_target() {
        let mut target = Sidecar::new();
        target.insert("Moog".into(), InstrumentMeta { notes: "old".into(), ..Default::default() });
        target.insert("Sub".into(), InstrumentMeta { notes: "keep".into(), ..Default::default() });
        let mut incoming = Sidecar::new();
        incoming.insert("Moog".into(), InstrumentMeta { notes: "new".into(), ..Default::default() });

        let merged = merge_sidecar(target, incoming);
        assert_eq!(merged["Moog"].notes, "new");
        assert_eq!(merged["Sub"].notes, "keep");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Unsaved::default())
        .on_window_event(guard_close)
        .invoke_handler(tauri::generate_handler![
            load_library,
            save_library,
            validate_library,
            apply_fixes,
            merge_sidecar,
            parse_chart,
            suggest_label,
            set_dirty,
        ]);
    #[cfg(target_os = "macos")]
    let builder = builder.menu(guarded_quit::menu).on_menu_event(guarded_quit::on_event);
    builder
        .run(tauri::generate_context!())
        .expect("error while running application");
}
