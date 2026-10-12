$ErrorActionPreference = 'SilentlyContinue'

# Compile the D3DKMT temperature reader once at startup (same code as temp-test.ps1)
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

  public static double Read(uint low, int high) {
    var open = new OPENFROMLUID();
    open.Luid.Low = low; open.Luid.High = high;
    if (D3DKMTOpenAdapterFromLuid(ref open) != 0) return -1;
    try {
      int size = Marshal.SizeOf(typeof(PERFDATA));
      IntPtr buf = Marshal.AllocHGlobal(size);
      try {
        Marshal.StructureToPtr(new PERFDATA(), buf, false);
        var q = new QUERYINFO { hAdapter = open.hAdapter, Type = KMTQAITYPE_ADAPTERPERFDATA, pData = buf, Size = (uint)size };
        if (D3DKMTQueryAdapterInfo(ref q) != 0) return -1;
        var perf = (PERFDATA)Marshal.PtrToStructure(buf, typeof(PERFDATA));
        return perf.Temperature / 10.0;
      } finally { Marshal.FreeHGlobal(buf); }
    } finally { uint h = open.hAdapter; D3DKMTCloseAdapter(ref h); }
  }
}
"@

while ($true) {
  # Pick the adapter using the most VRAM (Usually your GPU), and get its LUID
  $mem = (Get-Counter '\GPU Adapter Memory(*)\Dedicated Usage').CounterSamples |
         Sort-Object CookedValue -Descending | Select-Object -First 1
  $luid = $mem.InstanceName -replace '_phys_\d+$', ''

  # Sum 3D engine load, but only for engines on that same adapter
  $load = ((Get-Counter '\GPU Engine(*engtype_3D)\Utilization Percentage').CounterSamples |
           Where-Object InstanceName -like "*$luid*" |
           Measure-Object CookedValue -Sum).Sum

  # Temperature via D3DKMT: LUID name is luid_0xHIGH_0xLOW
  $parts = $luid -split '_'
  $high  = [Convert]::ToInt32($parts[1].Substring(2), 16)
  $low   = [Convert]::ToUInt32($parts[2].Substring(2), 16)
  $t     = [GpuTemp]::Read($low, $high)
  $temp  = if ($t -gt 0) { [math]::Round($t, 1) } else { $null }   # 0 or -1 = unavailable

  [pscustomobject]@{
    load   = [math]::Round([double]$load, 1)
    vramMB = [math]::Round($mem.CookedValue / 1MB)
    temp   = $temp
  } | ConvertTo-Json -Compress
}