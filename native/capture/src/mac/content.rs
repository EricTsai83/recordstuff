//! What ScreenCaptureKit may capture, and the filter for one recording: the chosen display without RecordStuff's own
//! windows and sound (075's D14, always), and optionally without the menu bar, the Dock, desktop icons and widgets
//! (076's D6).

use std::sync::mpsc::channel;
use std::time::Duration;

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::{AnyThread, msg_send, sel};
use objc2_foundation::{NSArray, NSError, NSObjectProtocol};
use objc2_screen_capture_kit::{SCContentFilter, SCDisplay, SCRunningApplication, SCShareableContent, SCWindow};

use super::{CaptureError, Unsent};

/// SCStreamErrorUserDeclined: the user has not granted screen recording.
const USER_DECLINED: isize = -3801;
const CONTENT_TIMEOUT: Duration = Duration::from_secs(15);

/// kCGDockWindowLevel, kCGMainMenuWindowLevel and kCGStatusWindowLevel.
const DOCK_LEVEL: isize = 20;
const MENU_BAR_LEVEL: isize = 24;
const STATUS_LEVEL: isize = 25;
/// Apps whose windows below the normal level are desktop furniture: Finder's desktop icons, the widgets on the
/// desktop. Their other windows (Finder's own windows, notification banners) stay.
const DESKTOP_OWNERS: [&str; 2] = ["com.apple.finder", "com.apple.notificationcenterui"];

pub fn describe(error: &NSError) -> String {
    format!("{} ({} {})", error.localizedDescription(), error.domain(), error.code())
}

/// The windows, displays and apps that can be captured now. Asking is what macOS checks the screen recording grant
/// against, so a missing grant surfaces here as `permission_denied`.
pub fn shareable_content() -> Result<Retained<SCShareableContent>, CaptureError> {
    let (sender, receiver) = channel::<Result<Unsent<SCShareableContent>, CaptureError>>();
    let block = RcBlock::new(move |content: *mut SCShareableContent, error: *mut NSError| {
        let result = match unsafe { Retained::retain(content) } {
            Some(content) => Ok(Unsent(content)),
            None => Err(match unsafe { error.as_ref() } {
                Some(error) if error.code() == USER_DECLINED => CaptureError::new("permission_denied", describe(error)),
                Some(error) => CaptureError::new("capture_start_failed", format!("shareable content: {}", describe(error))),
                None => CaptureError::new("capture_start_failed", "shareable content: no content and no error"),
            }),
        };
        let _ = sender.send(result);
    });
    // Off-screen windows too: a menu bar app with no visible window is otherwise missing from `applications`, and
    // excluding its app also leaves out the windows it opens later (the countdown overlay).
    unsafe {
        SCShareableContent::getShareableContentExcludingDesktopWindows_onScreenWindowsOnly_completionHandler(false, false, &block);
    }
    match receiver.recv_timeout(CONTENT_TIMEOUT) {
        Ok(result) => result.map(|content| content.0),
        Err(_) => Err(CaptureError::new("capture_start_failed", "shareable content did not arrive within 15 s")),
    }
}

pub fn find_display(content: &SCShareableContent, display_id: u32) -> Result<Retained<SCDisplay>, CaptureError> {
    let displays = unsafe { content.displays() };
    displays
        .iter()
        .find(|display| unsafe { display.displayID() } == display_id)
        .ok_or_else(|| CaptureError::new("no_display", format!("display {display_id} is not available for capture")))
}

fn bundle_id(app: &SCRunningApplication) -> String {
    unsafe { app.bundleIdentifier() }.to_string()
}

/// RecordStuff's own processes: those `pids` name, and every app whose bundle identifier begins with that of the
/// first one (main), which covers its helpers.
fn own_apps(content: &SCShareableContent, pids: &[i32]) -> Vec<Retained<SCRunningApplication>> {
    let apps = unsafe { content.applications() };
    let main_bundle = pids.first().and_then(|main| {
        apps.iter().find(|app| unsafe { app.processID() } == *main).map(|app| bundle_id(&app)).filter(|id| !id.is_empty())
    });
    apps.iter()
        .filter(|app| {
            pids.contains(&unsafe { app.processID() })
                || main_bundle.as_ref().is_some_and(|prefix| bundle_id(app).starts_with(prefix.as_str()))
        })
        .collect()
}

/// System chrome to leave out (D6): the menu bar and its status items, the Dock, desktop icons and widgets. An app's
/// open menu is that app's window above these levels, so it is still recorded.
fn system_ui_windows(content: &SCShareableContent, own: &[Retained<SCRunningApplication>]) -> Vec<Retained<SCWindow>> {
    let own_pids: Vec<i32> = own.iter().map(|app| unsafe { app.processID() }).collect();
    let windows = unsafe { content.windows() };
    windows
        .iter()
        .filter(|window| {
            let owner = unsafe { window.owningApplication() };
            // An excepted window of an excluded app would be shown again (see `filter`).
            if owner.as_ref().is_some_and(|app| own_pids.contains(&unsafe { app.processID() })) {
                return false;
            }
            let bundle = owner.as_ref().map(|app| bundle_id(app)).unwrap_or_default();
            let layer = unsafe { window.windowLayer() };
            layer == MENU_BAR_LEVEL
                || layer == STATUS_LEVEL
                || (layer == DOCK_LEVEL && bundle == "com.apple.dock")
                || (layer < 0 && DESKTOP_OWNERS.contains(&bundle.as_str()))
        })
        .collect()
}

pub struct Filter {
    pub filter: Retained<SCContentFilter>,
    pub excluded_apps: usize,
    pub hidden_windows: usize,
    pub warnings: Vec<String>,
}

/// The display without RecordStuff's apps, whose windows and sound ScreenCaptureKit then leaves out, including
/// windows opened later. With `hide_system_ui`, the system chrome's windows are listed as exceptions: an exception
/// whose app is not excluded is left out, which is how one filter excludes both whole apps and single windows.
pub fn filter(content: &SCShareableContent, display: &SCDisplay, own_pids: &[i32], hide_system_ui: bool) -> Filter {
    let own = own_apps(content, own_pids);
    let hidden = if hide_system_ui { system_ui_windows(content, &own) } else { Vec::new() };
    let apps = NSArray::from_retained_slice(&own);
    let windows = NSArray::from_retained_slice(&hidden);
    let filter = unsafe {
        SCContentFilter::initWithDisplay_excludingApplications_exceptingWindows(SCContentFilter::alloc(), display, &apps, &windows)
    };
    let mut warnings = Vec::new();
    if hide_system_ui {
        // macOS 14.2 and later; status items and the menu bar's own window are excepted above in any case.
        if filter.respondsToSelector(sel!(setIncludeMenuBar:)) {
            let _: () = unsafe { msg_send![&filter, setIncludeMenuBar: false] };
        } else {
            warnings.push("this macOS cannot leave the menu bar out with includeMenuBar".into());
        }
    }
    if own.is_empty() {
        warnings.push("RecordStuff's own app was not found among the shareable applications; its windows may be recorded".into());
    }
    Filter { filter, excluded_apps: own.len(), hidden_windows: hidden.len(), warnings }
}

/// Pixels per point of what `filter` captures, so the source size is known before choosing the output size.
pub fn point_pixel_scale(filter: &SCContentFilter) -> f64 {
    let info = unsafe { SCShareableContent::infoForFilter(filter) };
    f64::from(unsafe { info.pointPixelScale() })
}
