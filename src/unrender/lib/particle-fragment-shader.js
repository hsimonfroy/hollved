module.exports = [
'uniform vec3 color;',
'uniform sampler2D texture;',
'',
'varying vec4 vColor;',
'varying float vPointSize;',
'',
'void main() {',
'  vec4 tColor = texture2D( texture, gl_PointCoord );',
'  if (tColor.a < 0.01) discard;',
'  float alpha = tColor.a * vColor.a * min(vPointSize, 1.0);',
'  gl_FragColor = vec4( color * vColor.rgb, alpha );',
'}'
].join('\n');
