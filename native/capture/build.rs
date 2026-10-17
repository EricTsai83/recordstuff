//! The Node module's link settings, and the camera compositor's shader (plan 075, D15): `shaders/compose.wgsl` is the
//! one source, validated and translated here with naga to Metal's MSL, which mac/compositor.rs compiles at run time,
//! and to Direct3D 11's HLSL (shader model 5.0) for the Windows compositor. A shader that does not validate or
//! translate fails the build on every platform, whichever one it is built for.

use std::collections::BTreeMap;
use std::path::PathBuf;

use naga::back::{hlsl, msl};
use naga::valid::{Capabilities, ValidationFlags, Validator};
use naga::{ResourceBinding, ShaderStage};

const SHADER: &str = "shaders/compose.wgsl";
const ENTRY_POINTS: [&str; 2] = ["luma", "chroma"];

fn main() {
    napi_build::setup();
    println!("cargo:rerun-if-changed={SHADER}");
    let source = std::fs::read_to_string(SHADER).expect("read the compositor's shader");
    let module = naga::front::wgsl::parse_str(&source).unwrap_or_else(|e| panic!("{SHADER}: {}", e.emit_to_string(&source)));
    let info = Validator::new(ValidationFlags::all(), Capabilities::empty())
        .validate(&module)
        .unwrap_or_else(|e| panic!("{SHADER} does not validate: {}", e.emit_to_string(&source)));
    let out = PathBuf::from(std::env::var("OUT_DIR").unwrap());

    // Metal: per entry point, the parameters in buffer 0 and the screen's plane, the camera's plane, the output's plane
    // and the camera's chroma plane in textures 0, 1, 2 and 3, as mac/compositor.rs binds them (`luma` reads the
    // camera's chroma to convert a BT.601 frame; `chroma` has it as its camera plane already).
    let target = |buffer: Option<u8>, texture: Option<u8>| msl::BindTarget { buffer, texture, sampler: None, external_texture: None, mutable: false };
    let binding = |n: u32| ResourceBinding { group: 0, binding: n };
    let mut per_entry_point_map = BTreeMap::new();
    for (name, (screen, camera, output)) in [("luma", (1, 3, 5)), ("chroma", (2, 4, 6))] {
        let mut resources = BTreeMap::new();
        resources.insert(binding(0), target(Some(0), None));
        resources.insert(binding(screen), target(None, Some(0)));
        resources.insert(binding(camera), target(None, Some(1)));
        resources.insert(binding(output), target(None, Some(2)));
        if name == "luma" {
            resources.insert(binding(4), target(None, Some(3)));
        }
        per_entry_point_map.insert(name.to_owned(), msl::EntryPointResources { resources, immediates_buffer: None, sizes_buffer: None });
    }
    let options = msl::Options { lang_version: (2, 0), per_entry_point_map, fake_missing_bindings: false, ..msl::Options::default() };
    let pipeline = msl::PipelineOptions::default();
    let (metal, translated) = msl::write_string(&module, &info, &options, &pipeline).expect("translate the compositor's shader to MSL");
    let names: Vec<String> = translated.entry_point_names.into_iter().map(|name| name.expect("an MSL entry point")).collect();

    // Direct3D 11: registers by binding (b0, t1 to t4, u5 and u6), as the Windows compositor will bind them.
    let options = hlsl::Options { shader_model: hlsl::ShaderModel::V5_0, fake_missing_bindings: true, ..hlsl::Options::default() };
    let mut direct3d = String::new();
    let mut writer = hlsl::Writer::new(&mut direct3d, &options, &hlsl::PipelineOptions { entry_point: None });
    let reflected = writer.write(&module, &info, None).expect("translate the compositor's shader to HLSL");
    let hlsl_names: Vec<String> = reflected.entry_point_names.into_iter().map(|name| name.expect("an HLSL entry point")).collect();

    let order: Vec<&str> = module.entry_points.iter().map(|entry| entry.name.as_str()).collect();
    assert!(module.entry_points.iter().all(|entry| entry.stage == ShaderStage::Compute), "{SHADER}: compute entry points only");
    let name_of = |names: &[String], wanted: &str| names[order.iter().position(|name| *name == wanted).expect("an entry point")].clone();
    let constants: String = ENTRY_POINTS
        .iter()
        .map(|entry| {
            format!(
                "pub const MSL_{0}: &str = {1:?};\n#[allow(dead_code)]\npub const HLSL_{0}: &str = {2:?};\n",
                entry.to_uppercase(),
                name_of(&names, entry),
                name_of(&hlsl_names, entry)
            )
        })
        .collect();
    std::fs::write(out.join("compose.metal"), metal).unwrap();
    std::fs::write(out.join("compose.hlsl"), direct3d).unwrap();
    std::fs::write(out.join("compose_names.rs"), constants).unwrap();
}
