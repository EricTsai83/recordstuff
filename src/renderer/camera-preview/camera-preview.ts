/**
 * Plan 075 step 2's preview page: draws the engine's NV12 preview frames (D17's first option) with WebGL, the luma and
 * chroma planes uploaded as two textures and converted to RGB with BT.709's video-range matrix in the shader, and
 * shows how many frames arrived and how late, for the gate's measurement.
 */
import { CAMERA_PREVIEW_PORT_CHANNEL as CHANNEL } from "../../shared/camera-preview";
import { nv12Planes, previewStats, type PreviewMessage } from "./nv12";

const VERTEX = `
attribute vec2 position;
varying vec2 uv;
void main() {
  uv = vec2((position.x + 1.0) / 2.0, (1.0 - position.y) / 2.0);
  gl_Position = vec4(position, 0.0, 1.0);
}`;

const FRAGMENT = `
precision mediump float;
varying vec2 uv;
uniform sampler2D luma;
uniform sampler2D chroma;
void main() {
  float y = (texture2D(luma, uv).r * 255.0 - 16.0) / 219.0;
  vec2 c = (texture2D(chroma, uv).ra * 255.0 - 128.0) / 224.0;
  gl_FragColor = vec4(y + 1.5748 * c.y, y - 0.1873 * c.x - 0.4681 * c.y, y + 1.8556 * c.x, 1.0);
}`;

function compile(gl: WebGLRenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? "shader failed");
  return shader;
}

function texture(gl: WebGLRenderingContext, unit: number): WebGLTexture {
  const made = gl.createTexture()!;
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(gl.TEXTURE_2D, made);
  for (const [key, value] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]] as const) {
    gl.texParameteri(gl.TEXTURE_2D, key, value);
  }
  return made;
}

function start(canvas: HTMLCanvasElement, status: HTMLElement): void {
  const gl = canvas.getContext("webgl", { alpha: false, antialias: false, preserveDrawingBuffer: false });
  if (!gl) {
    status.textContent = "WebGL is not available";
    return;
  }
  const program = gl.createProgram()!;
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT));
  gl.linkProgram(program);
  gl.useProgram(program);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const position = gl.getAttribLocation(program, "position");
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
  const luma = texture(gl, 0);
  const chroma = texture(gl, 1);
  gl.uniform1i(gl.getUniformLocation(program, "luma"), 0);
  gl.uniform1i(gl.getUniformLocation(program, "chroma"), 1);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

  const stats = previewStats();
  const draw = (message: PreviewMessage): void => {
    const planes = nv12Planes(message);
    if (!planes) return;
    if (canvas.width !== message.width || canvas.height !== message.height) {
      canvas.width = message.width;
      canvas.height = message.height;
      gl.viewport(0, 0, message.width, message.height);
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, luma);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, message.width, message.height, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, planes.luma);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, chroma);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE_ALPHA, message.width / 2, message.height / 2, 0, gl.LUMINANCE_ALPHA, gl.UNSIGNED_BYTE, planes.chroma);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    status.textContent = stats.add(message, Date.now());
  };

  window.addEventListener("message", (event) => {
    if (event.data !== CHANNEL || !event.ports[0]) return;
    const port = event.ports[0];
    stats.reset();
    status.textContent = "Joined to the capture process; waiting for frames…";
    port.onmessage = (frame) => draw(frame.data as PreviewMessage);
    port.start();
  });
}

const canvas = document.getElementById("preview");
const status = document.getElementById("status");
if (canvas instanceof HTMLCanvasElement && status) start(canvas, status);
