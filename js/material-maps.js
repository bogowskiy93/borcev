/**
 * GTA clothing spec maps are linear data: R controls specular intensity,
 * G controls the specular exponent; B is not metalness or roughness.
 * https://blancodagoat.dev/gtav-rage-formats/ped-materials/
 *
 * Pack PBR roughness into G and specular intensity into A for Three.js.
 * Blinn-Phong -> GGX is an approximation. OBJ does not store GTA's shader
 * multipliers, so use a moderate falloff unless supplied in textures.
 */
export function packSpecularPixels(source, falloff = 128, intensity = 1) {
  const result = new Uint8Array(source.length);
  for (let i = 0; i < source.length; i += 4) {
    const r = source[i] / 255;
    const g = source[i + 1] / 255;
    const exponent = g * g * falloff * 3;
    const roughness = Math.min(1, Math.pow(2 / (exponent + 2), 0.25));
    result[i] = 255;
    result[i + 1] = Math.round(roughness * 255);
    result[i + 2] = 0;
    result[i + 3] = Math.round(Math.min(1, r * r * intensity) * 255);
  }
  return result;
}

export function getNormalScale(format = 'directx') {
  // GTA / DirectX normals use -Y; Three.js expects OpenGL +Y.
  return [1, format.toLowerCase() === 'opengl' ? 1 : -1];
}
