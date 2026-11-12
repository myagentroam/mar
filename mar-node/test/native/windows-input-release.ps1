$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class NativeRelease {
    [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT {
        public ushort vk, scan;
        public uint flags, time;
        public UIntPtr extra;
    }
    [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT {
        public int x, y;
        public uint data, flags, time;
        public UIntPtr extra;
    }
    [StructLayout(LayoutKind.Explicit)] public struct UNION {
        [FieldOffset(0)] public KEYBDINPUT keyboard;
        [FieldOffset(0)] public MOUSEINPUT mouse;
    }
    [StructLayout(LayoutKind.Sequential)] public struct INPUT {
        public uint type;
        public UNION input;
    }
    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint SendInput(uint count, INPUT[] inputs, int size);
    public static uint Release() {
        INPUT[] inputs = new INPUT[2];
        inputs[0].type = 1;
        inputs[0].input.keyboard.vk = 0x41;
        inputs[0].input.keyboard.flags = 0x0002;
        inputs[1].type = 0;
        inputs[1].input.mouse.flags = 0x0004;
        return SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
    }
}
'@
$count = [NativeRelease]::Release()
if ($count -ne 2) { throw "SendInput accepted $count of 2 releases" }
Write-Output 'SendInput accepted 2 of 2 releases'
