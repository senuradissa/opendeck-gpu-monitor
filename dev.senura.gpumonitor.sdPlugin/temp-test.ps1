# temp-test.ps1 - read GPU temperature the same way Task Manager does (D3DKMT)
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class GpuTemp {
  [StructLayout(LayoutKind.Sequential)] struct LUID { public uint Low; public int High; }
  [StructLayout(LayoutKind.Sequential)] struct OPENFROMLUID { public LUID Luid; public uint hAdapter; }
  [StructLayout(LayoutKind.Sequential)] struct QUERYINFO { public uint hAdapter; public int Type; public IntPtr pData; public uint Size; }
  [StructLayout(LayoutKind.Sequential)] struct PERFDATA {
    public uint PhysicalAdapterIndex;
    public ulong MemoryFrequency, MaxMemoryFrequency, MaxMemoryFrequencyOC, MemoryBandwidth, PCIEBandwidth;
    public uint FanRPM, Power, Temperature;   // Temperature is in tenths of a degree C
    public byte PowerStateOverride;
  }

  [DllImport("gdi32.dll")] static extern int D3DKMTOpenAdapterFromLuid(ref OPENFROMLUID p);
  [DllImport("gdi32.dll")] static extern int D3DKMTQueryAdapterInfo(ref QUERYINFO p);
  [DllImport("gdi32.dll")] static extern int D3DKMTCloseAdapter(ref uint hAdapter);

  const int KMTQAITYPE_ADAPTERPERFDATA = 62;

  // Returns degrees C, or -1 if the adapter can't be opened / queried
  public static double Read(uint low, int high) {
    var open = new OPENFROMLUID();
    open.Luid.Low = low; open.Luid.High = high;
    if (D3DKMTOpenAdapterFromLuid(ref open) != 0) return -1;
    try {
      int size = Marshal.SizeOf(typeof(PERFDATA));
      IntPtr buf = Marshal.AllocHGlobal(size);
      try {
        Marshal.StructureToPtr(new PERFDATA(), buf, false);   // zeroed, PhysicalAdapterIndex = 0
        var q = new QUERYINFO { hAdapter = open.hAdapter, Type = KMTQAITYPE_ADAPTERPERFDATA, pData = buf, Size = (uint)size };
        if (D3DKMTQueryAdapterInfo(ref q) != 0) return -1;
        var perf = (PERFDATA)Marshal.PtrToStructure(buf, typeof(PERFDATA));
        return perf.Temperature / 10.0;
      } finally { Marshal.FreeHGlobal(buf); }
    } finally { uint h = open.hAdapter; D3DKMTCloseAdapter(ref h); }
  }
}
"@

# Find the busiest adapter's LUID, same as the sampler
$mem = (Get-Counter '\GPU Adapter Memory(*)\Dedicated Usage').CounterSamples |
       Sort-Object CookedValue -Descending | Select-Object -First 1
$parts = $mem.InstanceName -split '_'          # luid, 0xHIGH, 0xLOW, phys, 0
$high  = [Convert]::ToInt32($parts[1].Substring(2), 16)
$low   = [Convert]::ToUInt32($parts[2].Substring(2), 16)

"Adapter: $($mem.InstanceName)"
while ($true) {
  "Temperature: $([GpuTemp]::Read($low, $high)) C"
  Start-Sleep -Seconds 1
}