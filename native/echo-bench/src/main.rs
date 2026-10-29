//! `recordstuff-echo-bench <condition-directory> <c1|c2|c3|none> <output.wav> [--two-pass]`: processes the condition's
//! `mic.wav` with its `reference.wav` and prints one JSON line: the take's seconds, the processing seconds on one
//! thread and their ratio. Exit 2 for a usage or input error.
use recordstuff_echo_bench::{Candidate, RATE, mono, process, read_wav, write_wav};
use std::time::Instant;

fn fail(message: &str) -> ! {
    eprintln!(
        "{message}\nusage: recordstuff-echo-bench <condition-directory> <c1|c2|c3|none> <output.wav> [--two-pass]"
    );
    std::process::exit(2);
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() < 3 || args.len() > 4 || (args.len() == 4 && args[3] != "--two-pass") {
        fail("wrong arguments");
    }
    let candidate = Candidate::parse(&args[1]).unwrap_or_else(|| fail("unknown candidate"));
    let read = |name: &str| -> Vec<Vec<f32>> {
        let path = std::path::Path::new(&args[0]).join(name);
        let bytes = std::fs::read(&path)
            .unwrap_or_else(|error| fail(&format!("{}: {error}", path.display())));
        let (rate, channels) =
            read_wav(&bytes).unwrap_or_else(|error| fail(&format!("{}: {error}", path.display())));
        if rate != RATE {
            fail(&format!("{}: {rate} Hz, not {RATE}", path.display()));
        }
        channels
    };
    let mic = mono(&read("mic.wav"));
    let reference = read("reference.wav");
    let two_pass = args.len() == 4;
    let started = Instant::now();
    let out = process(&mic, &reference, candidate, two_pass);
    let elapsed = started.elapsed().as_secs_f64();
    std::fs::write(&args[2], write_wav(&out))
        .unwrap_or_else(|error| fail(&format!("{}: {error}", args[2])));
    let seconds = mic.len() as f64 / RATE as f64;
    #[cfg(feature = "c3")]
    let state = recordstuff_echo_bench::c3::STATE_BYTES;
    #[cfg(not(feature = "c3"))]
    let state = 0;
    println!(
        "{{\"candidate\":\"{}\",\"twoPass\":{two_pass},\"seconds\":{seconds:.3},\"processingSeconds\":{elapsed:.4},\"realtime\":{:.1},\"c3StateBytes\":{state}}}",
        args[1],
        seconds / elapsed.max(1e-9)
    );
}
