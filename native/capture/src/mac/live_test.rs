//! Real recordings of step 4's sources on this Mac (plan 076): a window, an area of the display, chosen apps' windows
//! and sound, and the microphone mixed in, each three seconds through a whole session, then the file read back.
//! Ignored by default, since they need a desktop and the screen recording grant (and the microphone's for that test)
//! for the process that runs them: `cargo test --lib -- --ignored --nocapture mac::live_test`. Without a grant the test
//! says so and passes, so the source is reported untested rather than failed.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use objc2_screen_capture_kit::SCShareableContent;

use super::content;
use super::session::{Session, probe};
use crate::core::{AudioRequest, CaptureError, Events, PrepareRequest, Prepared, Source, Stopped, SystemAudio};
use crate::mux::parse::{Mp4, parse};
use crate::writer::WriteFailure;

#[derive(Default)]
struct Heard(Mutex<Vec<String>>);

impl Events for Heard {
    fn progress(&self, _bytes: u64) {}
    fn write_failed(&self, failure: WriteFailure) {
        self.0.lock().unwrap().push(format!("write {}: {}", failure.code, failure.detail));
    }
    fn capture_failed(&self, code: &'static str, detail: String) {
        self.0.lock().unwrap().push(format!("capture {code}: {detail}"));
    }
    fn microphone_lost(&self, detail: String) {
        self.0.lock().unwrap().push(format!("microphone lost: {detail}"));
    }
    fn microphone_resumed(&self, detail: String) {
        self.0.lock().unwrap().push(format!("microphone resumed: {detail}"));
    }
}

fn main_display() -> u32 {
    unsafe extern "C" {
        fn CGMainDisplayID() -> u32;
    }
    unsafe { CGMainDisplayID() }
}

/// True, after saying so, when this process may not capture or listen.
fn untested(what: &str, error: &CaptureError) -> bool {
    let denied = error.code == "permission_denied" || error.detail.contains("not allowed");
    if denied {
        println!("macOS live {what} UNTESTED: {}: {}", error.code, error.detail);
    }
    denied
}

/// A normal on-screen window of another app, at least 300 by 200 points, with its owner's pid.
fn some_window(content: &SCShareableContent) -> Option<(u64, i32)> {
    let own = std::process::id() as i32;
    unsafe { content.windows() }.iter().find_map(|window| {
        let frame = unsafe { window.frame() };
        let owner = unsafe { window.owningApplication() }?;
        let pid = unsafe { owner.processID() };
        let usable = unsafe { window.windowLayer() } == 0 && unsafe { window.isOnScreen() } && frame.size.width >= 300.0 && frame.size.height >= 200.0;
        (usable && pid != own).then(|| (u64::from(unsafe { window.windowID() }), pid))
    })
}

fn record(name: &str, source: Source, audio: AudioRequest) -> Option<(Prepared, Stopped, Mp4)> {
    let (width, height) = match probe(main_display(), None, &source) {
        Ok(size) => size,
        Err(error) if untested(name, &error) => return None,
        Err(error) => panic!("{name}: probe failed: {}: {}", error.code, error.detail),
    };
    let (width, height) = (width.min(1920) & !1, height.min(1080) & !1);
    let path = std::env::temp_dir().join(format!("recordstuff-mac-live-{name}-{}.mp4", std::process::id()));
    std::fs::File::create(&path).unwrap();
    let heard = Arc::new(Heard::default());
    let request = PrepareRequest {
        display_id: main_display(),
        display_point: None,
        width,
        height,
        frame_rate: 30,
        video_bitrate: 6_000_000,
        audio_bitrate: 256_000,
        own_pids: vec![std::process::id() as i32],
        hide_system_ui: false,
        path: path.clone(),
        source,
        audio,
        camera: None,
        editable: false,
    };
    let (mut session, prepared) = match Session::prepare(request, heard.clone()) {
        Ok(prepared) => prepared,
        Err(error) if untested(name, &error) => {
            let _ = std::fs::remove_file(&path);
            return None;
        }
        Err(error) => panic!("{name}: prepare failed: {}: {}", error.code, error.detail),
    };
    println!("macOS live {name}: prepared {}x{} ({}); warnings {:?}", prepared.width, prepared.height, prepared.timings, prepared.warnings);
    session.record().unwrap();
    std::thread::sleep(Duration::from_secs(3));
    let (stopped, finishing) = session.stop();
    let finished = finishing.wait().unwrap_or_else(|failure| panic!("{name}: finishing failed: {}: {}", failure.code, failure.detail));
    assert!(heard.0.lock().unwrap().is_empty(), "{name}: {:?}", heard.0.lock().unwrap());
    assert_eq!(finished.fragmented, None);
    let file = parse(&std::fs::read(&path).unwrap()).unwrap();
    if std::env::var_os("RECORDSTUFF_KEEP_LIVE").is_some() {
        println!("macOS live {name}: kept {}", path.display());
    } else {
        let _ = std::fs::remove_file(&path);
    }
    let (video, audio) = (&file.tracks[0], &file.tracks[1]);
    let video_ms = video.duration as f64 * 1000.0 / f64::from(video.timescale);
    let audio_ms = audio.edit.map_or(0.0, |(presented, _)| presented as f64 * 1000.0 / 48_000.0);
    println!(
        "macOS live {name}: {} video samples over {video_ms:.0} ms, {} audio packets presenting {audio_ms:.0} ms; drain {:.0} ms, {} frames filled, late {:?}",
        video.samples.len(),
        audio.samples.len(),
        stopped.drain_ms,
        stopped.drain_padded_frames,
        stopped.late_audio_frames
    );
    assert!((2_800.0..3_400.0).contains(&video_ms), "{name}: video lasts {video_ms} ms");
    assert!((video_ms - audio_ms).abs() < 1.0, "{name}: video {video_ms} ms, audio {audio_ms} ms");
    Some((prepared, stopped, file))
}

#[test]
#[ignore = "records a window; needs the screen recording grant"]
fn live_window_of_another_app() {
    let content = match content::shareable_content() {
        Ok(content) => content,
        Err(error) if untested("window", &error) => return,
        Err(error) => panic!("{}: {}", error.code, error.detail),
    };
    let Some((window, _)) = some_window(&content) else {
        println!("macOS live window UNTESTED: no other app has a window on screen");
        return;
    };
    record("window", Source::Window(window), AudioRequest::default());
}

#[test]
#[ignore = "records an area of the display; needs the screen recording grant"]
fn live_area_of_the_display() {
    if let Some((prepared, _, _)) = record("area", Source::Area { x: 100, y: 80, width: 800, height: 450 }, AudioRequest::default()) {
        assert_eq!((prepared.width, prepared.height), (800, 450));
    }
}

#[test]
#[ignore = "records one app's windows and sound; needs the screen recording grant"]
fn live_one_apps_windows_and_sound() {
    let content = match content::shareable_content() {
        Ok(content) => content,
        Err(error) if untested("apps", &error) => return,
        Err(error) => panic!("{}: {}", error.code, error.detail),
    };
    let Some((_, pid)) = some_window(&content) else {
        println!("macOS live apps UNTESTED: no other app has a window on screen");
        return;
    };
    record("apps", Source::Apps(vec![pid]), AudioRequest { system: SystemAudio::Apps(vec![pid]), microphone: None });
}

#[test]
#[ignore = "records the display with the microphone mixed in; needs the screen recording and microphone grants"]
fn live_display_with_the_microphone() {
    match super::microphone::list() {
        Ok(found) => println!("macOS microphones: {:?}", found.iter().map(|m| (&m.name, m.default)).collect::<Vec<_>>()),
        Err(error) => println!("macOS microphones could not be listed: {}", error.detail),
    }
    record("microphone", Source::Display, AudioRequest { system: SystemAudio::All, microphone: Some(None) });
}

#[test]
#[ignore = "records the display with only the microphone; needs the screen recording and microphone grants"]
fn live_display_with_only_the_microphone() {
    // With RECORDSTUFF_KEEP_LIVE the file stays, so its level shows whether the microphone's sound arrived; a default
    // input with nothing behind it (a display's) is silence, so RECORDSTUFF_LIVE_MICROPHONE picks one by name.
    println!("macOS live microphone-only: authorization {:?} (3 is authorized)", super::microphone::authorization().map_err(|e| e.detail));
    let wanted = std::env::var("RECORDSTUFF_LIVE_MICROPHONE").ok();
    let device = wanted.and_then(|name| {
        let found = super::microphone::list().ok()?.into_iter().find(|m| m.name.contains(&name));
        println!("macOS live microphone-only: {name:?} is {found:?}");
        found.map(|m| m.id)
    });
    record("microphone-only", Source::Display, AudioRequest { system: SystemAudio::Off, microphone: Some(device) });
}

/// Plan 078 step 6, for 075's camera: whether a camera that is disconnected and connected again is followed, in a
/// process without a main run loop as the capture `utilityProcess` is, by CoreMediaIO's device list and by
/// AVFoundation's, read once a second for `RECORDSTUFF_PROBE_SECONDS` (60) while someone unplugs a camera or takes an
/// iPhone's Continuity Camera away and back. Prints each list whenever it changes; captures nothing.
#[test]
#[ignore = "a probe for someone to unplug and plug back a camera while it runs"]
fn probe_cameras_coming_and_going() {
    use objc2_av_foundation::{AVCaptureDevice, AVMediaTypeVideo};
    use objc2_core_foundation::{CFRetained, CFString};
    use std::ffi::c_void;
    use std::ptr::{NonNull, null};

    #[repr(C)]
    struct Address {
        selector: u32,
        scope: u32,
        element: u32,
    }
    #[link(name = "CoreMediaIO", kind = "framework")]
    unsafe extern "C" {
        fn CMIOObjectGetPropertyDataSize(object: u32, address: *const Address, qualifier_size: u32, qualifier: *const c_void, size: *mut u32) -> i32;
        fn CMIOObjectGetPropertyData(
            object: u32,
            address: *const Address,
            qualifier_size: u32,
            qualifier: *const c_void,
            size: u32,
            used: *mut u32,
            data: *mut c_void,
        ) -> i32;
    }
    let code = |text: &[u8; 4]| u32::from_be_bytes(*text);
    let address = |selector: &[u8; 4]| Address { selector: code(selector), scope: code(b"glob"), element: 0 };
    let cmio = || -> Vec<String> {
        let mut size = 0u32;
        if unsafe { CMIOObjectGetPropertyDataSize(1, &address(b"dev#"), 0, null(), &mut size) } != 0 {
            return vec!["(the device list could not be read)".into()];
        }
        let mut ids = vec![0u32; size as usize / 4];
        let mut used = 0u32;
        unsafe { CMIOObjectGetPropertyData(1, &address(b"dev#"), 0, null(), size, &mut used, ids.as_mut_ptr().cast()) };
        ids.truncate(used as usize / 4);
        ids.iter()
            .map(|&id| {
                let mut name: usize = 0;
                let mut used = 0u32;
                let status = unsafe { CMIOObjectGetPropertyData(id, &address(b"lnam"), 0, null(), 8, &mut used, (&raw mut name).cast()) };
                let name = NonNull::new(name as *mut CFString).filter(|_| status == 0).map(|text| unsafe { CFRetained::from_raw(text) }.to_string());
                name.unwrap_or_else(|| format!("device {id}"))
            })
            .collect()
    };
    let avfoundation = || -> Vec<String> {
        let Some(media) = (unsafe { AVMediaTypeVideo }) else { return Vec::new() };
        #[allow(deprecated)]
        let devices = unsafe { AVCaptureDevice::devicesWithMediaType(media) };
        devices.iter().map(|device| unsafe { device.localizedName() }.to_string()).collect()
    };
    let seconds: u64 = std::env::var("RECORDSTUFF_PROBE_SECONDS").ok().and_then(|s| s.parse().ok()).unwrap_or(60);
    let began = std::time::Instant::now();
    let (mut last_cmio, mut last_av) = (Vec::new(), Vec::new());
    while began.elapsed().as_secs() < seconds {
        let (now_cmio, now_av) = (cmio(), avfoundation());
        if now_cmio != last_cmio {
            println!("{:>5.1} s CoreMediaIO: {now_cmio:?}", began.elapsed().as_secs_f64());
            last_cmio = now_cmio;
        }
        if now_av != last_av {
            println!("{:>5.1} s AVFoundation: {now_av:?}", began.elapsed().as_secs_f64());
            last_av = now_av;
        }
        std::thread::sleep(std::time::Duration::from_secs(1));
    }
}

/// Plan 075 step 2: the camera opened in a process without a main run loop delivers frames, and a composed frame
/// holds them. `RECORDSTUFF_PROBE_SECONDS` (3) long; prints the frames delivered, the rate and the camera's size.
/// Without camera access for the process that runs it, says so and passes.
#[test]
#[ignore = "needs a camera and camera access for the process that runs it"]
fn camera_delivers_without_a_run_loop() {
    use super::camera::CameraCapture;
    let seconds: u64 = std::env::var("RECORDSTUFF_PROBE_SECONDS").ok().and_then(|s| s.parse().ok()).unwrap_or(3);
    if super::camera::authorization().unwrap_or(0) == 0 {
        // Never asked for this process (its responsible app): ask, and wait for the answer.
        let (sender, receiver) = std::sync::mpsc::channel();
        let block = block2::RcBlock::new(move |granted: objc2::runtime::Bool| {
            let _ = sender.send(granted.as_bool());
        });
        let media = unsafe { objc2_av_foundation::AVMediaTypeVideo }.unwrap();
        let _: () = unsafe {
            objc2::msg_send![<objc2_av_foundation::AVCaptureDevice as objc2::ClassType>::class(), requestAccessForMediaType: media, completionHandler: &*block]
        };
        println!("camera access asked: {:?}", receiver.recv_timeout(Duration::from_secs(60)));
    }
    let camera = match CameraCapture::start(std::env::var("RECORDSTUFF_CAMERA_DEVICE").ok().as_deref(), Arc::new(Heard::default()), || true) {
        Ok(camera) => camera,
        Err(error) => {
            println!("macOS live camera UNTESTED: {}: {}", error.code, error.detail);
            return;
        }
    };
    std::thread::sleep(Duration::from_secs(seconds));
    let delivered = camera.feed.counts().0;
    let size = camera.feed.latest().map(|(image, _)| (objc2_core_video::CVPixelBufferGetWidth(&image.0), objc2_core_video::CVPixelBufferGetHeight(&image.0)));
    println!("camera {}: {delivered} frames in {seconds} s ({:.1} fps), size {size:?}; {}", camera.name, delivered as f64 / seconds as f64, camera.state());
    crate::core::CameraControl::close(&*camera);
    assert!(delivered as f64 >= seconds as f64 * 10.0, "the camera delivered {delivered} frames in {seconds} s");
}
