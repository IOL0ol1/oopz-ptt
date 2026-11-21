namespace OopzPtt;

// 托盘图标在运行时绘制，按状态换颜色，避免打包多份 .ico
internal static unsafe class MicIcon
{
    public static IntPtr Create(int size, uint argb)
    {
        var bih = new Native.BITMAPINFOHEADER
        {
            biSize = (uint)sizeof(Native.BITMAPINFOHEADER),
            biWidth = size,
            biHeight = -size,
            biPlanes = 1,
            biBitCount = 32,
        };
        void* bits;
        var color = Native.CreateDIBSection(IntPtr.Zero, &bih, 0, &bits, IntPtr.Zero, 0);
        if (color == IntPtr.Zero) return IntPtr.Zero;

        var px = (uint*)bits;
        uint rgb = argb & 0x00FFFFFF;
        const int ss = 4;
        for (int y = 0; y < size; y++)
        {
            for (int x = 0; x < size; x++)
            {
                int hit = 0;
                for (int sy = 0; sy < ss; sy++)
                for (int sx = 0; sx < ss; sx++)
                {
                    float u = (x + (sx + 0.5f) / ss) / size;
                    float v = (y + (sy + 0.5f) / ss) / size;
                    if (Shape(u, v) <= 0) hit++;
                }
                uint a = (uint)(hit * 255 / (ss * ss));
                px[y * size + x] = (a << 24) | rgb;
            }
        }

        int stride = ((size + 15) / 16) * 2;
        var maskBits = new byte[stride * size];
        IntPtr mask;
        fixed (byte* mb = maskBits) mask = Native.CreateBitmap(size, size, 1, 1, mb);

        var info = new Native.ICONINFO { fIcon = 1, hbmMask = mask, hbmColor = color };
        var icon = Native.CreateIconIndirect(&info);
        Native.DeleteObject(color);
        Native.DeleteObject(mask);
        return icon;
    }

    // 有向距离场：话筒 + 支架 + 立杆 + 底座，坐标归一化到 [0,1]
    static float Shape(float x, float y)
    {
        const float w = 0.05f;
        float d = Segment(x, y, 0.5f, 0.27f, 0.5f, 0.45f) - 0.15f;

        float rx = x - 0.5f, ry = y - 0.46f;
        float arc = ry >= 0
            ? MathF.Abs(MathF.Sqrt(rx * rx + ry * ry) - 0.28f) - w
            : MathF.Min(Dist(x, y, 0.22f, 0.46f), Dist(x, y, 0.78f, 0.46f)) - w;
        d = MathF.Min(d, arc);
        d = MathF.Min(d, Segment(x, y, 0.5f, 0.74f, 0.5f, 0.86f) - w);
        d = MathF.Min(d, Segment(x, y, 0.34f, 0.88f, 0.66f, 0.88f) - w);
        return d;
    }

    static float Dist(float x, float y, float ax, float ay)
    {
        float dx = x - ax, dy = y - ay;
        return MathF.Sqrt(dx * dx + dy * dy);
    }

    static float Segment(float x, float y, float ax, float ay, float bx, float by)
    {
        float pax = x - ax, pay = y - ay, bax = bx - ax, bay = by - ay;
        float h = Math.Clamp((pax * bax + pay * bay) / (bax * bax + bay * bay), 0f, 1f);
        return Dist(pax, pay, bax * h, bay * h);
    }
}
