# Envia um arquivo de bytes ESC/POS em modo RAW para uma impressora instalada no Windows.
# Chamado pelo worker de impressão (apps/server/src/printing/transport.ts).
# Uso: powershell -ExecutionPolicy Bypass -File raw-print.ps1 -PrinterName "ELGIN i9" -Path cupom.bin
# Erros saem no stderr com o prefixo "ERRO:" e código de saída 1.

param(
  [Parameter(Mandatory = $true)][string]$PrinterName,
  [Parameter(Mandatory = $true)][string]$Path
)

$ErrorActionPreference = 'Stop'

$source = @'
using System;
using System.Runtime.InteropServices;

public static class SistemaBarRawPrinter {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public class DOCINFO {
    [MarshalAs(UnmanagedType.LPWStr)] public string pDocName;
    [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile;
    [MarshalAs(UnmanagedType.LPWStr)] public string pDataType;
  }

  [DllImport("winspool.drv", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool OpenPrinter(string name, out IntPtr handle, IntPtr defaults);
  [DllImport("winspool.drv", SetLastError = true)]
  static extern bool ClosePrinter(IntPtr handle);
  [DllImport("winspool.drv", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern int StartDocPrinter(IntPtr handle, int level, [In] DOCINFO info);
  [DllImport("winspool.drv", SetLastError = true)]
  static extern bool EndDocPrinter(IntPtr handle);
  [DllImport("winspool.drv", SetLastError = true)]
  static extern bool StartPagePrinter(IntPtr handle);
  [DllImport("winspool.drv", SetLastError = true)]
  static extern bool EndPagePrinter(IntPtr handle);
  [DllImport("winspool.drv", SetLastError = true)]
  static extern bool WritePrinter(IntPtr handle, byte[] bytes, int count, out int written);

  public static void Send(string printer, byte[] data) {
    IntPtr h;
    if (!OpenPrinter(printer, out h, IntPtr.Zero))
      throw new Exception("impressora nao encontrada no Windows: " + printer + " (codigo " + Marshal.GetLastWin32Error() + ")");
    try {
      DOCINFO info = new DOCINFO();
      info.pDocName = "Sistema Bar";
      info.pDataType = "RAW";
      if (StartDocPrinter(h, 1, info) == 0)
        throw new Exception("o spooler recusou o documento (codigo " + Marshal.GetLastWin32Error() + ")");
      try {
        StartPagePrinter(h);
        int written;
        if (!WritePrinter(h, data, data.Length, out written) || written != data.Length)
          throw new Exception("falha ao enviar os dados (codigo " + Marshal.GetLastWin32Error() + ")");
        EndPagePrinter(h);
      } finally {
        EndDocPrinter(h);
      }
    } finally {
      ClosePrinter(h);
    }
  }
}
'@

try {
  if (-not ('SistemaBarRawPrinter' -as [type])) { Add-Type -TypeDefinition $source -Language CSharp }
  $bytes = [System.IO.File]::ReadAllBytes($Path)
  [SistemaBarRawPrinter]::Send($PrinterName, $bytes)
} catch {
  $msg = $_.Exception.Message
  if ($_.Exception.InnerException) { $msg = $_.Exception.InnerException.Message }
  [Console]::Error.WriteLine("ERRO: $msg")
  exit 1
}
