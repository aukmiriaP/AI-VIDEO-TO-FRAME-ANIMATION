import type { Light } from './types'

const vertex = `
attribute vec2 position;
varying vec2 uv;
void main(){ uv=position*.5+.5; gl_Position=vec4(position,0.,1.); }
`
const fragment = `
precision highp float;
varying vec2 uv;
uniform sampler2D colorMap, normalMap;
uniform vec2 size, lightXY;
uniform float lightZ, intensity, radius, ambient;
uniform vec3 tint;
void main(){
  vec4 base=texture2D(colorMap,uv);
  vec3 normal=normalize(texture2D(normalMap,uv).rgb*2.-1.);
  vec2 pixel=vec2(uv.x,1.-uv.y)*size;
  vec3 delta=vec3(lightXY.x-pixel.x,pixel.y-lightXY.y,lightZ);
  float distance=length(delta);
  float falloff=pow(max(0.,1.-distance/radius),2.);
  float diffuse=max(0.,dot(normal,normalize(delta)));
  vec3 linear=pow(base.rgb,vec3(2.2));
  vec3 lit=linear*(vec3(ambient)+tint*intensity*diffuse*falloff);
  gl_FragColor=vec4(pow(max(lit,vec3(0.)),vec3(1./2.2)),base.a);
}`

/** Persistent offscreen GPU renderer: changing the lamp only updates uniforms. */
export class LightingRenderer {
  canvas = document.createElement('canvas')
  private gl: WebGLRenderingContext
  private program: WebGLProgram
  private textures = new Map<HTMLImageElement, WebGLTexture>()
  constructor() {
    const gl = this.canvas.getContext('webgl', { alpha:true, premultipliedAlpha:false })
    if (!gl) throw new Error('实时打光需要 WebGL，请检查浏览器硬件加速。')
    this.gl = gl
    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type)!
      gl.shaderSource(shader, source); gl.compileShader(shader)
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) || '打光着色器编译失败')
      return shader
    }
    this.program = gl.createProgram()!
    const vs=compile(gl.VERTEX_SHADER,vertex), fs=compile(gl.FRAGMENT_SHADER,fragment)
    gl.attachShader(this.program,vs); gl.attachShader(this.program,fs); gl.linkProgram(this.program)
    gl.deleteShader(vs);gl.deleteShader(fs)
    if (!gl.getProgramParameter(this.program,gl.LINK_STATUS)) throw new Error('打光着色器连接失败')
    gl.useProgram(this.program)
    const buffer=gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER,buffer)
    gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,1,1]),gl.STATIC_DRAW)
    const position=gl.getAttribLocation(this.program,'position')
    gl.enableVertexAttribArray(position);gl.vertexAttribPointer(position,2,gl.FLOAT,false,0,0)
  }
  render(color: HTMLImageElement, normal: HTMLImageElement, light: Light, pixel: boolean) {
    const gl=this.gl
    if (gl.isContextLost()) throw new Error('打光上下文已丢失，请刷新页面。')
    const w=color.naturalWidth,h=color.naturalHeight
    if (w!==normal.naturalWidth || h!==normal.naturalHeight) throw new Error('颜色帧与法线尺寸不一致，请重新生成法线。')
    if (this.canvas.width!==w || this.canvas.height!==h) {this.canvas.width=w;this.canvas.height=h}
    gl.viewport(0,0,w,h);gl.useProgram(this.program)
    const bind=(image:HTMLImageElement,unit:number,name:string)=>{
      gl.activeTexture(gl.TEXTURE0+unit)
      let texture=this.textures.get(image)
      if(!texture){
        texture=gl.createTexture()!
        this.textures.set(image,texture);gl.bindTexture(gl.TEXTURE_2D,texture)
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,true)
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,false)
        gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL,gl.NONE)
        gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,image)
        gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE)
        gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE)
        if(this.textures.size>64){
          const first=this.textures.keys().next().value!
          gl.deleteTexture(this.textures.get(first)!);this.textures.delete(first)
        }
      }else gl.bindTexture(gl.TEXTURE_2D,texture)
      const filter=pixel?gl.NEAREST:gl.LINEAR
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,filter)
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,filter)
      gl.uniform1i(gl.getUniformLocation(this.program,name),unit)
    }
    bind(color,0,'colorMap');bind(normal,1,'normalMap')
    const at=(name:string)=>gl.getUniformLocation(this.program,name)
    const extent=Math.max(w,h)
    gl.uniform2f(at('size'),w,h);gl.uniform2f(at('lightXY'),light.x*w,light.y*h)
    gl.uniform1f(at('lightZ'),Math.max(1,light.height*extent))
    gl.uniform1f(at('radius'),light.range*extent);gl.uniform1f(at('intensity'),light.intensity)
    gl.uniform1f(at('ambient'),light.ambient)
    gl.uniform3fv(at('tint'),new Float32Array([1,3,5].map(i=>Math.pow(parseInt(light.color.slice(i,i+2),16)/255,2.2))))
    gl.drawArrays(gl.TRIANGLE_STRIP,0,4)
    return this.canvas
  }
  dispose(){this.gl.getExtension('WEBGL_lose_context')?.loseContext();this.textures.clear()}
}
