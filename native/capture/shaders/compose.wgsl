// The camera composed into a 4:2:0 frame (plan 075, D2 and D15), one source for every platform: build.rs translates
// it with naga to Metal's MSL (macOS) and Direct3D 11's HLSL (Windows), so the rounding, the crop and the mirror are
// one formula wherever they are drawn. `luma` writes the output's Y plane and `chroma` its interleaved CbCr plane;
// each samples the same plane of the screen's frame and of the camera's, both in video-range YUV, and blends them by
// the bubble's coverage, which is anti-aliased over one pixel of the luma plane.
//
// The output may be smaller than the screen's frame (the preview): the screen is sampled at the output's pixel
// centres, which at the same size reads each pixel exactly.

struct Params {
    // The output's luma size in pixels.
    out_size: vec2<f32>,
    // The bubble in output luma pixels, from the top-left corner.
    bubble_origin: vec2<f32>,
    bubble_size: vec2<f32>,
    // The part of the camera's picture that fills the bubble, in normalised coordinates (camera_layout::camera_crop).
    crop_origin: vec2<f32>,
    crop_size: vec2<f32>,
    // A circular arc's radius in output luma pixels (camera_layout::Layout::radius).
    radius: f32,
    // 1 mirrors the camera left to right.
    mirror: f32,
    // 0 when there is no camera frame yet: the screen alone.
    camera_on: f32,
    // 1 when the camera's frame is BT.601 YCbCr, which is converted to the output's BT.709 before it is blended.
    camera_601: f32,
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var screen_y: texture_2d<f32>;
@group(0) @binding(2) var screen_uv: texture_2d<f32>;
@group(0) @binding(3) var camera_y: texture_2d<f32>;
@group(0) @binding(4) var camera_uv: texture_2d<f32>;
@group(0) @binding(5) var out_y: texture_storage_2d<r8unorm, write>;
@group(0) @binding(6) var out_uv: texture_storage_2d<rg8unorm, write>;

// A texture read between texels, bilinearly, at `uv` in normalised coordinates: by hand rather than with a sampler,
// which naga's HLSL writes as a Direct3D 12 sampler heap that Direct3D 11 does not have.
fn bilinear(t: texture_2d<f32>, uv: vec2<f32>) -> vec4<f32> {
    let size = vec2<f32>(textureDimensions(t));
    let texel = clamp(uv * size - vec2<f32>(0.5, 0.5), vec2<f32>(0.0, 0.0), size - vec2<f32>(1.0, 1.0));
    let base = floor(texel);
    let f = texel - base;
    let last = vec2<i32>(size) - vec2<i32>(1, 1);
    let a = vec2<i32>(base);
    let b = min(a + vec2<i32>(1, 1), last);
    let top = mix(textureLoad(t, a, 0), textureLoad(t, vec2<i32>(b.x, a.y), 0), f.x);
    let bottom = mix(textureLoad(t, vec2<i32>(a.x, b.y), 0), textureLoad(t, b, 0), f.x);
    return mix(top, bottom, f.y);
}

// How much of the luma pixel centred at `p` the bubble covers: a rounded rectangle's signed distance, anti-aliased.
fn coverage(p: vec2<f32>) -> f32 {
    if (params.camera_on < 0.5) {
        return 0.0;
    }
    let half_size = params.bubble_size * 0.5;
    let local = p - (params.bubble_origin + half_size);
    let r = min(params.radius, min(half_size.x, half_size.y));
    let q = abs(local) - half_size + vec2<f32>(r, r);
    let distance = length(max(q, vec2<f32>(0.0, 0.0))) + min(max(q.x, q.y), 0.0) - r;
    return clamp(0.5 - distance, 0.0, 1.0);
}

// The coverage of a chroma sample whose centre is at `p` in luma pixels: the mean of its four luma pixels', so a bubble
// edge crossing it blends its colour as much as its brightness.
fn chroma_coverage(p: vec2<f32>) -> f32 {
    return 0.25 * (coverage(p + vec2<f32>(-0.5, -0.5)) + coverage(p + vec2<f32>(0.5, -0.5))
        + coverage(p + vec2<f32>(-0.5, 0.5)) + coverage(p + vec2<f32>(0.5, 0.5)));
}

// Video-range CbCr codes, centred and scaled to [-0.5, 0.5].
fn centred(uv: vec2<f32>) -> vec2<f32> {
    return (uv * 255.0 - vec2<f32>(128.0, 128.0)) / 224.0;
}

// The camera's luma at `uv`, in the output's BT.709: a BT.601 frame's luma also depends on its chroma.
fn camera_luma(uv: vec2<f32>) -> f32 {
    let y = bilinear(camera_y, uv).r;
    if (params.camera_601 < 0.5) {
        return y;
    }
    let c = centred(bilinear(camera_uv, uv).rg);
    let level = (y * 255.0 - 16.0) / 219.0 - 0.118188 * c.x - 0.212685 * c.y;
    return (level * 219.0 + 16.0) / 255.0;
}

// The camera's CbCr at `uv`, in the output's BT.709.
fn camera_chroma(uv: vec2<f32>) -> vec2<f32> {
    let raw = bilinear(camera_uv, uv).rg;
    if (params.camera_601 < 0.5) {
        return raw;
    }
    let c = centred(raw);
    let converted = vec2<f32>(1.018640 * c.x + 0.114618 * c.y, 0.075049 * c.x + 1.025327 * c.y);
    return (converted * 224.0 + vec2<f32>(128.0, 128.0)) / 255.0;
}

// Where the luma pixel centred at `p` reads the camera, in normalised coordinates.
fn camera_at(p: vec2<f32>) -> vec2<f32> {
    var f = (p - params.bubble_origin) / params.bubble_size;
    if (params.mirror > 0.5) {
        f.x = 1.0 - f.x;
    }
    return params.crop_origin + clamp(f, vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 1.0)) * params.crop_size;
}

@compute @workgroup_size(16, 16, 1)
fn luma(@builtin(global_invocation_id) id: vec3<u32>) {
    let size = textureDimensions(out_y);
    if (id.x >= size.x || id.y >= size.y) {
        return;
    }
    let p = vec2<f32>(f32(id.x), f32(id.y)) + vec2<f32>(0.5, 0.5);
    var y = bilinear(screen_y, p / params.out_size).r;
    let c = coverage(p);
    if (c > 0.0) {
        y = mix(y, camera_luma(camera_at(p)), c);
    }
    textureStore(out_y, vec2<i32>(i32(id.x), i32(id.y)), vec4<f32>(y, 0.0, 0.0, 1.0));
}

@compute @workgroup_size(16, 16, 1)
fn chroma(@builtin(global_invocation_id) id: vec3<u32>) {
    let size = textureDimensions(out_uv);
    if (id.x >= size.x || id.y >= size.y) {
        return;
    }
    // The chroma sample's centre in luma pixels.
    let p = (vec2<f32>(f32(id.x), f32(id.y)) + vec2<f32>(0.5, 0.5)) * 2.0;
    var uv = bilinear(screen_uv, p / params.out_size).rg;
    let c = chroma_coverage(p);
    if (c > 0.0) {
        uv = mix(uv, camera_chroma(camera_at(p)), c);
    }
    textureStore(out_uv, vec2<i32>(i32(id.x), i32(id.y)), vec4<f32>(uv, 0.0, 1.0));
}
