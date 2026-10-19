//! The input level meter in Settings (plan 079, D1) on macOS: the microphone a recording would open, read through the
//! same AUHAL input unit (hal.rs) in the capture process that lists the inputs, its levels told 20 times a second
//! (core/meter.rs). Nothing is resampled, mixed or written. A device that leaves or that the HAL moves ends the meter
//! with `lost`; main starts it again once the device list changes (D2).

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{RecvTimeoutError, sync_channel};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use super::CaptureError;
pub use super::hal::DeviceWatch;
use super::hal::{self, InputUnit};
use super::microphone;
use crate::core::meter::LevelMeter;
pub use crate::core::meter::MeterEvent;

pub struct Meter {
    /// The device read: the chosen one, or the default input when it is not connected, as a recording would.
    pub name: String,
    stopped: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl Meter {
    pub fn start(device: Option<&str>, tell: impl Fn(MeterEvent) + Send + 'static) -> Result<Self, CaptureError> {
        microphone::allowed()?;
        let (input, _) = microphone::resolve(device)?;
        let (chunks, received) = sync_channel(hal::POOL);
        let unit = InputUnit::open(input.id, chunks)
            .map_err(|why| CaptureError::new("microphone_unavailable", format!("microphone: {} could not be opened: {why}", input.name)))?;
        let stopped = Arc::new(AtomicBool::new(false));
        let running = stopped.clone();
        let name = input.name.clone();
        let thread = std::thread::Builder::new()
            .name("recordstuff-meter".into())
            .spawn(move || {
                let mut meter = LevelMeter::new(unit.rate);
                let mut checked = Instant::now();
                while !running.load(Ordering::Acquire) {
                    match received.recv_timeout(Duration::from_millis(250)) {
                        Ok(chunk) => {
                            meter.push(&chunk.samples, |level| tell(MeterEvent::Level(level)));
                            let _ = unit.recycle.try_send(chunk.samples);
                        }
                        Err(RecvTimeoutError::Timeout) => {}
                        Err(RecvTimeoutError::Disconnected) => return,
                    }
                    if checked.elapsed() >= Duration::from_millis(250) {
                        checked = Instant::now();
                        if let Some(why) = unit.moved() {
                            tell(MeterEvent::Lost(format!("{} stopped being read ({why})", input.name)));
                            return;
                        }
                    }
                }
            })
            .map_err(|e| CaptureError::new("microphone_unavailable", format!("microphone: the meter's thread: {e}")))?;
        Ok(Self { name, stopped, thread: Some(thread) })
    }
}

impl Drop for Meter {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::Release);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}
