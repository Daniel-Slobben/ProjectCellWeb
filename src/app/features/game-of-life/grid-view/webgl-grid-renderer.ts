export class WebGLGridRenderer {
  private gl!: WebGLRenderingContext;
  private program!: WebGLProgram;

  private positionBuffer!: WebGLBuffer;
  private texCoordBuffer!: WebGLBuffer;

  private positionLocation!: number;
  private texCoordLocation!: number;
  private samplerLocation!: WebGLUniformLocation;

  private readonly vertices = new Float32Array(8);

  private readonly blockTextures = new Map<string, WebGLTexture>();

  private canvasWidth!: number;
  private canvasHeight!: number;

  init(canvas: HTMLCanvasElement) {
    this.canvasWidth = canvas.width;
    this.canvasHeight = canvas.height;

    const gl = canvas.getContext("webgl", {
      alpha: false,
      antialias: false
    });

    if (!gl) {
      throw new Error("WebGL not supported");
    }

    this.gl = gl;

    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 1);

    this.program = this.createProgram();

    this.positionLocation = gl.getAttribLocation(this.program, "position");
    this.texCoordLocation = gl.getAttribLocation(this.program, "texCoord");

    const sampler = gl.getUniformLocation(this.program, "texture");

    if (!sampler) {
      throw new Error("Could not find sampler uniform");
    }

    this.samplerLocation = sampler;

    this.createBuffers();

    gl.useProgram(this.program);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.texCoordBuffer);
    gl.enableVertexAttribArray(this.texCoordLocation);
    gl.vertexAttribPointer(this.texCoordLocation, 2, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
    gl.enableVertexAttribArray(this.positionLocation);
    gl.vertexAttribPointer(this.positionLocation, 2, gl.FLOAT, false, 0, 0);

    gl.uniform1i(this.samplerLocation, 0);
  }

  clear() {
    this.gl.clear(this.gl.COLOR_BUFFER_BIT);
  }

  private createShader(type: number, source: string) {
    const gl = this.gl;

    const shader = gl.createShader(type)!;

    gl.shaderSource(shader, source);
    gl.compileShader(shader);

    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(shader)!);
    }

    return shader;
  }

  private createProgram() {
    const gl = this.gl;

    const vertex = this.createShader(gl.VERTEX_SHADER, `
attribute vec2 position;
attribute vec2 texCoord;

varying vec2 vTexCoord;

void main() {
    gl_Position = vec4(position, 0.0, 1.0);
    vTexCoord = texCoord;
}
`);

    const fragment = this.createShader(gl.FRAGMENT_SHADER, `
precision mediump float;

uniform sampler2D texture;

varying vec2 vTexCoord;

void main() {
    gl_FragColor = texture2D(texture, vTexCoord);
}
`);

    const program = gl.createProgram()!;

    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);

    gl.linkProgram(program);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(program)!);
    }

    return program;
  }

  private createBuffers() {
    const gl = this.gl;

    this.positionBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);

    // Allocate once.
    gl.bufferData(gl.ARRAY_BUFFER, this.vertices.byteLength, gl.DYNAMIC_DRAW);

    this.texCoordBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.texCoordBuffer);

    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([
        0, 1,
        1, 1,
        0, 0,
        1, 0
      ]),
      gl.STATIC_DRAW
    );
  }

  updateTexture(key: string, imageData: ImageData) {
    let texture = this.blockTextures.get(key);

    if (!texture) {
      texture = this.createTexture(imageData);
      this.blockTextures.set(key, texture);
      return;
    }

    const gl = this.gl;

    gl.bindTexture(gl.TEXTURE_2D, texture);

    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      imageData
    );
  }

  private createTexture(imageData: ImageData): WebGLTexture {
    const gl = this.gl;

    const texture = gl.createTexture()!;

    gl.bindTexture(gl.TEXTURE_2D, texture);

    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      imageData.width,
      imageData.height,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      imageData.data
    );

    return texture;
  }

  getTexture(key: string) {
    return this.blockTextures.get(key);
  }

  deleteTexture(key: string) {
    const texture = this.blockTextures.get(key);

    if (!texture) return;

    this.gl.deleteTexture(texture);
    this.blockTextures.delete(key);
  }

  drawBlock(
    texture: WebGLTexture,
    x: number,
    y: number,
    width: number,
    height: number
  ) {
    const gl = this.gl;

    const left = (x / this.canvasWidth) * 2 - 1;
    const right = ((x + width) / this.canvasWidth) * 2 - 1;

    const top = 1 - (y / this.canvasHeight) * 2;
    const bottom = 1 - ((y + height) / this.canvasHeight) * 2;

    const v = this.vertices;

    v[0] = left;
    v[1] = bottom;

    v[2] = right;
    v[3] = bottom;

    v[4] = left;
    v[5] = top;

    v[6] = right;
    v[7] = top;

    gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, v);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
}
