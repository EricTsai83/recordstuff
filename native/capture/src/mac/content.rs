//! What ScreenCaptureKit may capture, and the filters for one recording: the chosen display without RecordStuff's own
//! windows and sound (075's D14, always), and optionally without the menu bar, the Dock, desktop icons and widgets
//! (076's D6); or one window, part of the display, or only chosen apps' windows (step 4, engine only). Sound follows a
//! stream's filter, so when the picture's filter is not the sound's (a window, chosen apps, or chosen apps' sound) the
//! sound comes from a second, audio-only stream with its own filter.

use std::sync::Mutex;
use std::sync::mpsc::channel;
use std::time::{Duration, Instant};

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::{AnyThread, msg_send, sel};
use objc2_core_foundation::{CGPoint, CGRect, CGSize};
use objc2_foundation::{NSArray, NSError, NSObjectProtocol};
use objc2_screen_capture_kit::{SCContentFilter, SCDisplay, SCRunningApplication, SCShareableContent, SCWindow};

use super::{CaptureError, Unsent};
use crate::core::{Source, SystemAudio};

/// SCStreamErrorUserDeclined: the user has not granted screen recording.
const USER_DECLINED: isize = -3801;
const CONTENT_TIMEOUT: Duration = Duration::from_secs(15);
/// How long `probe`'s content serves the `prepare` right after it: one attempt asks the system once.
const REUSE_WITHIN: Duration = Duration::from_secs(2);

static RECENT: Mutex<Option<(Instant, Unsent<SCShareableContent>)>> = Mutex::new(None);

/// Keeps `content` for the next `recent_or_fetch`.
pub fn remember(content: &Retained<SCShareableContent>) {
    *RECENT.lock().unwrap() = Some((Instant::now(), Unsent(content.clone())));
}

/// The content `remember` kept within the last two seconds, once; otherwise asks the system.
pub fn recent_or_fetch() -> Result<Retained<SCShareableContent>, CaptureError> {
    match RECENT.lock().unwrap().take() {
        Some((at, content)) if at.elapsed() < REUSE_WITHIN => Ok(content.0),
        _ => shareable_content(),
    }
}

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

/// Why `own_apps` found nothing, for the warning (plan 078 step 2): the processes asked for, how many applications and
/// windows the content lists, the windows owned by those processes, and the applications whose process is one of
/// them or whose bundle identifier is Electron's.
fn own_app_evidence(content: &SCShareableContent, pids: &[i32]) -> String {
    let apps = unsafe { content.applications() };
    let windows = unsafe { content.windows() };
    let owned = windows
        .iter()
        .filter(|window| unsafe { window.owningApplication() }.is_some_and(|app| pids.contains(&unsafe { app.processID() })))
        .count();
    let related: Vec<String> = apps
        .iter()
        .filter(|app| pids.contains(&unsafe { app.processID() }) || bundle_id(app).to_lowercase().contains("electron"))
        .map(|app| format!("{} pid {}", bundle_id(&app), unsafe { app.processID() }))
        .collect();
    format!(
        "pids {pids:?}; {} applications and {} windows listed, {owned} of them owned by those pids; related: [{}]",
        apps.len(),
        windows.len(),
        related.join(", ")
    )
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
        warnings.push(format!(
            "RecordStuff's own app was not found among the shareable applications; its windows may be recorded ({})",
            own_app_evidence(content, own_pids)
        ));
    }
    Filter { filter, excluded_apps: own.len(), hidden_windows: hidden.len(), warnings }
}

/// Pixels per point of what `filter` captures, so the source size is known before choosing the output size.
pub fn point_pixel_scale(filter: &SCContentFilter) -> f64 {
    let info = unsafe { SCShareableContent::infoForFilter(filter) };
    f64::from(unsafe { info.pointPixelScale() })
}

/// Connects this process to the window server once. A window filter needs the connection, which an app has but the
/// capture `utilityProcess` does not: without it CoreGraphics aborts the process (`CGS_REQUIRE_INIT`). Asking for the
/// main display makes it.
fn window_server() {
    static CONNECTED: std::sync::Once = std::sync::Once::new();
    unsafe extern "C" {
        fn CGMainDisplayID() -> u32;
    }
    CONNECTED.call_once(|| {
        unsafe { CGMainDisplayID() };
    });
}

fn find_window(content: &SCShareableContent, window_id: u64) -> Result<Retained<SCWindow>, CaptureError> {
    window_server();
    let windows = unsafe { content.windows() };
    windows
        .iter()
        .find(|window| u64::from(unsafe { window.windowID() }) == window_id)
        .ok_or_else(|| CaptureError::new("capture_start_failed", format!("window {window_id} is not available for capture (closed?)")))
}

/// The running apps among `pids` that are not RecordStuff's own.
fn chosen_apps(content: &SCShareableContent, pids: &[i32], own_pids: &[i32]) -> Result<Vec<Retained<SCRunningApplication>>, CaptureError> {
    let own: Vec<i32> = own_apps(content, own_pids).iter().map(|app| unsafe { app.processID() }).collect();
    let apps: Vec<_> = unsafe { content.applications() }
        .iter()
        .filter(|app| {
            let pid = unsafe { app.processID() };
            pids.contains(&pid) && !own.contains(&pid)
        })
        .collect();
    if apps.is_empty() {
        return Err(CaptureError::new("capture_start_failed", format!("none of the chosen apps ({pids:?}) is running with anything to capture")));
    }
    Ok(apps)
}

/// The picture's filter for `source`: what `filter` gives for the display, or one window, or chosen apps' windows.
/// An area is the display's filter cut by `area_rect`.
pub fn video_filter(
    content: &SCShareableContent,
    display: &SCDisplay,
    source: &Source,
    own_pids: &[i32],
    hide_system_ui: bool,
) -> Result<Filter, CaptureError> {
    match source {
        Source::Display | Source::Area { .. } => Ok(filter(content, display, own_pids, hide_system_ui)),
        Source::Window(id) => {
            let window = find_window(content, *id)?;
            let filter = unsafe { SCContentFilter::initWithDesktopIndependentWindow(SCContentFilter::alloc(), &window) };
            Ok(Filter { filter, excluded_apps: 0, hidden_windows: 0, warnings: Vec::new() })
        }
        Source::Apps(pids) => {
            let apps = chosen_apps(content, pids, own_pids)?;
            let hidden = if hide_system_ui { system_ui_windows(content, &own_apps(content, own_pids)) } else { Vec::new() };
            let filter = unsafe {
                SCContentFilter::initWithDisplay_includingApplications_exceptingWindows(
                    SCContentFilter::alloc(),
                    display,
                    &NSArray::from_retained_slice(&apps),
                    &NSArray::from_retained_slice(&hidden),
                )
            };
            Ok(Filter { filter, excluded_apps: 0, hidden_windows: hidden.len(), warnings: Vec::new() })
        }
    }
}

/// The filter of the audio-only stream, when the picture's stream cannot carry the sound asked for: `None` when it
/// can (the display or an area of it, with everything the system plays) or when no system sound is wanted.
pub fn audio_filter(
    content: &SCShareableContent,
    display: &SCDisplay,
    source: &Source,
    audio: &SystemAudio,
    own_pids: &[i32],
) -> Result<Option<Retained<SCContentFilter>>, CaptureError> {
    match (audio, source) {
        (SystemAudio::Off, _) | (SystemAudio::All, Source::Display | Source::Area { .. }) => Ok(None),
        (SystemAudio::All, _) => Ok(Some(filter(content, display, own_pids, false).filter)),
        (SystemAudio::Apps(pids), _) => {
            let apps = chosen_apps(content, pids, own_pids)?;
            Ok(Some(unsafe {
                SCContentFilter::initWithDisplay_includingApplications_exceptingWindows(
                    SCContentFilter::alloc(),
                    display,
                    &NSArray::from_retained_slice(&apps),
                    &NSArray::new(),
                )
            }))
        }
    }
}

/// The area in the display's points, which `SCStreamConfiguration.sourceRect` takes, from its pixels; refused when it
/// does not lie on the display.
pub fn area_rect(display: &SCDisplay, scale: f64, (x, y, width, height): (u32, u32, u32, u32)) -> Result<CGRect, CaptureError> {
    let (display_width, display_height) = (unsafe { display.width() } as f64 * scale, unsafe { display.height() } as f64 * scale);
    if f64::from(x + width) > display_width.round() || f64::from(y + height) > display_height.round() {
        return Err(CaptureError::new(
            "capture_start_failed",
            format!("the area {width}x{height} at {x},{y} does not lie on the {display_width:.0}x{display_height:.0} display"),
        ));
    }
    Ok(CGRect::new(
        CGPoint::new(f64::from(x) / scale, f64::from(y) / scale),
        CGSize::new(f64::from(width) / scale, f64::from(height) / scale),
    ))
}

/// The source's size in pixels.
pub fn source_size(content: &SCShareableContent, display: &SCDisplay, source: &Source) -> Result<(u32, u32), CaptureError> {
    match source {
        Source::Display | Source::Apps(_) => {
            let filter = filter(content, display, &[], false);
            let scale = point_pixel_scale(&filter.filter).max(1.0);
            Ok(((unsafe { display.width() } as f64 * scale).round() as u32, (unsafe { display.height() } as f64 * scale).round() as u32))
        }
        Source::Area { width, height, .. } => Ok((*width, *height)),
        Source::Window(id) => {
            let window = find_window(content, *id)?;
            let filter = unsafe { SCContentFilter::initWithDesktopIndependentWindow(SCContentFilter::alloc(), &window) };
            let scale = point_pixel_scale(&filter).max(1.0);
            let frame = unsafe { window.frame() };
            Ok(((frame.size.width * scale).round() as u32, (frame.size.height * scale).round() as u32))
        }
    }
}
