// SDR BGRA -> NV12, including output sizing, rotation and DXGI cursor composition.
cbuffer Settings : register(b0) {
    float4 sizes; // output width/height, rotated source width/height
    float4 conversion; // Kr, Kb, luma scale, luma offset
    float4 cursorRect;
    float4 mode; // rotation quarter turns, cursor kind (0 = none), chroma scale
};
struct Vertex { float4 position : SV_POSITION; float2 uv : TEXCOORD0; };
Vertex vs(uint id : SV_VertexID) {
    Vertex v;
    v.uv = float2((id << 1) & 2, id & 2);
    v.position = float4(v.uv * float2(2, -2) + float2(-1, 1), 0, 1);
    return v;
}
Texture2D image : register(t0);
Texture2D pointer : register(t1);
SamplerState linearClamp : register(s0);
float3 rgb(float2 pixel) {
    float2 uv = pixel / sizes.xy;
    float2 source = uv;
    if (mode.x == 1) source = float2(uv.y, 1 - uv.x);
    if (mode.x == 2) source = 1 - uv;
    if (mode.x == 3) source = float2(1 - uv.y, uv.x);
    float3 color = image.SampleLevel(linearClamp, source, 0).rgb;
    int2 p = int2(floor(uv * sizes.zw - cursorRect.xy));
    if (mode.y > 0 && all(p >= 0) && all(p < int2(cursorRect.zw))) {
        float4 c = pointer.Load(int3(p, 0));
        if (mode.y == 1) color = lerp(color, c.rgb, c.a);
        if (mode.y == 2) color = c.a > 0 ? float3(uint3(round(color * 255)) ^ uint3(round(c.rgb * 255))) / 255 : c.rgb;
        if (mode.y == 3) color = float3((uint3(round(color * 255)) & uint(round(c.r * 255))) ^ uint(round(c.g * 255))) / 255;
    }
    return color;
}
float luma(float3 color) { return dot(color, float3(conversion.x, 1 - conversion.x - conversion.y, conversion.y)); }
float psY(Vertex v) : SV_TARGET { return conversion.w + conversion.z * luma(rgb(v.position.xy)); }
float2 psUV(Vertex v) : SV_TARGET {
    float2 p = floor(v.position.xy) * 2 + 0.5;
    float3 color = (rgb(p) + rgb(p + float2(1, 0)) + rgb(p + float2(0, 1)) + rgb(p + 1)) / 4;
    float y = luma(color);
    return 128.0 / 255.0 + mode.z * float2((color.b - y) / (2 * (1 - conversion.y)), (color.r - y) / (2 * (1 - conversion.x)));
}
