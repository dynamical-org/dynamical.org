import { Layer, project32 } from "@deck.gl/core";
import { Model } from "@luma.gl/engine";
import { Colormap, LinearRescale } from "@developmentseed/deck.gl-raster/gpu-modules";

const leadUniform = {
  name: "lead",
  fs: `uniform leadUniforms { int index; } lead;`,
  uniformTypes: { index: "i32" },
};

const vs = `#version 300 es
in vec2 positions;
flat out int face;
void main() {
  face = gl_VertexID / 3;
  geometry.worldPosition = vec3(positions, 0.);
  gl_Position = project_position_to_clipspace(geometry.worldPosition, vec3(0.), vec3(0.), geometry.position);
  DECKGL_FILTER_GL_POSITION(gl_Position, geometry);
}
`;

const fs = `#version 300 es
precision highp float;
precision highp int;
uniform highp sampler2DArray values;
flat in int face;
out vec4 fragColor;
void main() {
  int width = textureSize(values, 0).x;
  float value = texelFetch(values, ivec3(face % width, face / width, lead.index), 0).r;
  if (isnan(value)) discard;
  fragColor = vec4(vec3(value), 1.);
  geometry.uv = vec2(0.);
  DECKGL_FILTER_COLOR(fragColor, geometry);
}
`;

export class CellChunkLayer extends Layer {
  static layerName = "CellChunkLayer";

  initializeState() {
    const { id, buffer, vertexCount } = this.props;
    const model = new Model(this.context.device, {
      ...this.getShaders({ vs, fs, modules: [project32, leadUniform, LinearRescale, Colormap] }),
      id,
      topology: "triangle-list",
      vertexCount,
      bufferLayout: [{ name: "positions", format: "float32x2" }],
      attributes: { positions: buffer },
    });
    this.setState({ model });
  }

  draw() {
    const { colormapTexture, colormapIndex, texture, layerIndex, min, max } = this.props;
    const { model } = this.state;
    model.setBindings({ values: texture });
    model.shaderInputs.setProps({
      lead: { index: layerIndex },
      linearRescale: { rescaleMin: min, rescaleMax: max },
      colormap: { colormapTexture, colormapIndex, reversed: 0 },
    });
    model.draw(this.context.renderPass);
  }

  finalizeState() {
    this.state.model?.destroy();
  }
}
