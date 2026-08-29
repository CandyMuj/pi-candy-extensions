$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.Encoding]::UTF8
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$log = "$env:TEMP\pi-notify-debug.log"
function l($m) { try { "$m" | Out-File -Append -Encoding utf8 $log } catch {} }

l '[host-start]'

Add-Type -AssemblyName PresentationFramework,PresentationCore,WindowsBase,System.Windows.Forms,System.Drawing
l '[host-assemblies-ok]'

# PF: 切回终端
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class PF {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumCb cb, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  public delegate bool EnumCb(IntPtr h, IntPtr l);
  public static string Search;
  public static IntPtr Found = IntPtr.Zero;
  public static string FoundTitle = "";
  public static bool Callback(IntPtr h, IntPtr l) {
    int len = GetWindowTextLength(h);
    if (len > 0) {
      var sb = new StringBuilder(len + 1);
      GetWindowText(h, sb, sb.Capacity);
      string t = sb.ToString();
      if (t.Contains(Search)) { Found = h; FoundTitle = t; return false; }
    }
    return true;
  }
}
"@

# HotkeyHelper: 热键注册 + WPF 窗口绑定
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Interop;
public class HotkeyHelper {
  [DllImport("user32.dll")] public static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);
  [DllImport("user32.dll")] public static extern bool UnregisterHotKey(IntPtr hWnd, int id);

  public static void Setup(Window win, Action dismiss, Action focus, int idDismiss, int idFocus) {
    var source = PresentationSource.FromVisual(win) as HwndSource;
    if (source == null) return;
    IntPtr hwnd = source.Handle;
    uint MOD_ALT = 0x0001;
    uint VK_OEM_4 = 0xDB;
    uint VK_OEM_6 = 0xDD;
    RegisterHotKey(hwnd, idDismiss, MOD_ALT, VK_OEM_4);
    RegisterHotKey(hwnd, idFocus, MOD_ALT, VK_OEM_6);
    source.AddHook((IntPtr h, int msg, IntPtr wp, IntPtr lp, ref bool handled) => {
      if (msg == 0x0312) {
        int id = wp.ToInt32();
        if (id == idDismiss) { handled = true; win.Dispatcher.Invoke(dismiss); }
        else if (id == idFocus) { handled = true; win.Dispatcher.Invoke(focus); }
      }
      return IntPtr.Zero;
    });
  }
}
"@ -ReferencedAssemblies "WindowsBase","PresentationCore","PresentationFramework","System.Xaml"

l '[host-compiled]'

function Build-Xaml($opacity, $dismissLabel, $continueLabel) {
  return @"
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
  xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
  WindowStyle="None" AllowsTransparency="True" Background="Transparent"
  Topmost="True" ShowActivated="False" ShowInTaskbar="False" ResizeMode="NoResize"
  Opacity="$opacity" Width="380" Height="115">
  <Window.Resources>
    <DropShadowEffect x:Key="shadow" BlurRadius="20" ShadowDepth="2" Opacity="0.3"/>
  </Window.Resources>
  <Border CornerRadius="10" Background="#2B2B2B" BorderBrush="#444" BorderThickness="1"
    Effect="{StaticResource shadow}">
    <Grid Margin="12">
      <Grid.RowDefinitions>
        <RowDefinition Height="Auto"/>
        <RowDefinition Height="*"/>
        <RowDefinition Height="Auto"/>
      </Grid.RowDefinitions>
      <TextBlock Grid.Row="0" x:Name="Title" FontWeight="SemiBold" Foreground="#E0E0E0" FontSize="13"/>
      <TextBlock Grid.Row="1" x:Name="Body" Foreground="#999" FontSize="12" Margin="0,4,0,6" TextWrapping="Wrap" VerticalAlignment="Top" TextTrimming="CharacterEllipsis"/>
      <Grid Grid.Row="2">
        <Grid.ColumnDefinitions>
          <ColumnDefinition Width="*"/>
          <ColumnDefinition Width="Auto"/>
        </Grid.ColumnDefinitions>
        <TextBlock x:Name="Timer" Foreground="#666" FontSize="11" VerticalAlignment="Bottom"/>
        <StackPanel Grid.Column="1" Orientation="Horizontal">
        <Button x:Name="MuteBtn" Width="32" Height="30" Margin="0,0,6,0" Cursor="Hand"
          ToolTip="勿扰">
          <Button.Template>
            <ControlTemplate TargetType="Button">
              <Border CornerRadius="4" Background="#3A3A3A">
                <TextBlock HorizontalAlignment="Center" VerticalAlignment="Center"
                  Text="🔕" FontSize="13" Foreground="#AAA"/>
              </Border>
            </ControlTemplate>
          </Button.Template>
        </Button>
        <Button x:Name="DismissBtn" Content="$dismissLabel" Width="78" Height="30" Margin="0,0,10,0" Cursor="Hand">
          <Button.Template>
            <ControlTemplate TargetType="Button">
              <Border CornerRadius="4" Background="#3A3A3A">
                <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center"
                  TextElement.Foreground="#CCC" TextElement.FontSize="12"/>
              </Border>
            </ControlTemplate>
          </Button.Template>
        </Button>
        <Button x:Name="FocusBtn" Content="$continueLabel" Width="78" Height="30" Cursor="Hand">
          <Button.Template>
            <ControlTemplate TargetType="Button">
              <Border CornerRadius="4" Background="#0E639C">
                <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center"
                  TextElement.Foreground="White" TextElement.FontSize="12"/>
              </Border>
            </ControlTemplate>
          </Button.Template>
        </Button>
        </StackPanel>
      </Grid>
    </Grid>
  </Border>
</Window>
"@
}

function Focus-PiTerminal($hwndNum, $winTitle) {
  l '[focus-called]'
  $h = [IntPtr]::new($hwndNum)
  if ([PF]::IsIconic($h)) { [PF]::ShowWindow($h, 9) }
  $r = [PF]::SetForegroundWindow($h)
  l "[focus-cached-sfg] result=$r"
  if ($r) { return }

  l "[focus-fallback] searching for '$winTitle'"
  [PF]::Search = $winTitle
  $cb = [PF+EnumCb]{ param($h2,$l2) [PF]::Callback($h2,$l2) }
  [PF]::EnumWindows($cb, [IntPtr]::Zero)
  if ([PF]::Found -ne [IntPtr]::Zero) {
    l "[focus-found] title='$([PF]::FoundTitle)' hwnd=$([PF]::Found)"
    if ([PF]::IsIconic([PF]::Found)) { [PF]::ShowWindow([PF]::Found, 9) }
    [PF]::SetForegroundWindow([PF]::Found) | Out-Null
  }
}

$stackFile = "$env:TEMP\pi-notify-stack.txt"
# 每次宿主启动重置计数器，避免崩溃残留导致窗口位置漂移
if (Test-Path $stackFile) { Remove-Item $stackFile -Force }

function inc-stack {
  $count = 0
  if (Test-Path $stackFile) { try { $count = [int](Get-Content $stackFile -Raw).Trim() } catch {} }
  # 保护：超过 10 层说明 dec-stack 泄露，重置
  if ($count -gt 10) { $count = 0; l '[stack-reset] overflow' }
  $count++
  $count | Out-File -Encoding ascii $stackFile
  return $count
}

function dec-stack {
  if (-not (Test-Path $stackFile)) { return }
  try {
    $c = [int](Get-Content $stackFile -Raw).Trim()
    $c--
    if ($c -le 0) { Remove-Item $stackFile -Force } else { $c | Out-File -Encoding ascii $stackFile }
  } catch {}
}

function Show-Notify($data) {
  $title   = $data.title
  $body    = $data.body
  $hwndNum = [long]$data.hwnd
  $winTitle= $data.winTitle
  $dismiss = $data.dismissLabel
  $continue= $data.continueLabel
  $timeout = [int]$data.timeoutSec
  $opacity = $data.opacityVal
  $elapsed = $data.elapsedLabel

  $MOD_ALT = 0x0001; $VK_OEM_4 = 0xDB; $VK_OEM_6 = 0xDD
  $HOTKEY_DISMISS = 1; $HOTKEY_FOCUS = 2

  $xamlText = Build-Xaml $opacity $dismiss $continue
  $reader = [System.Xml.XmlReader]::Create([System.IO.StringReader]$xamlText)
  $win = [System.Windows.Markup.XamlReader]::Load($reader)
  $reader.Close()

  $win.FindName('Title').Text = $title
  $win.FindName('Body').Text = $body
  $win.FindName('Timer').Text = $elapsed
  $win.FindName('DismissBtn').Add_Click({ $win.Close() })
  $win.FindName('FocusBtn').Add_Click({ $win.Close(); Focus-PiTerminal $hwndNum $winTitle })

  # 勿扰菜单
  $popup = New-Object System.Windows.Controls.Primitives.Popup
  $popup.PlacementTarget = $win.FindName('MuteBtn')
  $popup.Placement = [System.Windows.Controls.Primitives.PlacementMode]::Bottom
  $popup.StaysOpen = $false
  $popup.AllowsTransparency = $true

  $panel = New-Object System.Windows.Controls.StackPanel
  $panel.Background = "#333"
  $panel.MinWidth = 100

  $opts = @(
    @{Header=$data.mute3Label; Val=3},
    @{Header=$data.mute30Label; Val=30},
    @{Header=$data.mute60Label; Val=60},
    @{Header=$data.muteOffLabel; Val=0}
  )
  foreach ($o in $opts) {
    $btn = New-Object System.Windows.Controls.Button
    $btn.Content = $o.Header
    $btn.Background = "Transparent"
    $btn.Foreground = "#CCC"
    $btn.BorderThickness = 0
    $btn.FontSize = 12
    $btn.HorizontalContentAlignment = "Left"
    $btn.Padding = "10,6"
    $btn.Cursor = "Hand"
    $btn.Tag = $o.Val
    $btn.Add_Click({
      $popup.IsOpen = $false
      $win.Close()
      [Console]::WriteLine("MUTE:" + $this.Tag)
    }.GetNewClosure())
    $btn.Add_MouseEnter({ $this.Background = "#444" })
    $btn.Add_MouseLeave({ $this.Background = "Transparent" })
    $panel.Children.Add($btn) | Out-Null
  }
  $popup.Child = $panel
  $win.FindName('MuteBtn').Add_Click({ $popup.IsOpen = $true })

  $cursor = [System.Windows.Forms.Cursor]::Position
  $screen = [System.Windows.Forms.Screen]::FromPoint($cursor)
  # WinForms WorkingArea 是物理像素；WPF Window 坐标是设备无关像素 (DIP, 1/96in)。
  # 高分屏 (150%+/200%+) 下必须除以 DPI 缩放比。
  # 注意：PowerShell 宿主中 SystemParameters.DpiX 返回 0，必须用 System.Drawing。
  $gfx = [System.Drawing.Graphics]::FromHwnd([System.IntPtr]::Zero)
  try {
    $dpiScaleX = $gfx.DpiX / 96.0
    $dpiScaleY = $gfx.DpiY / 96.0
  } finally { $gfx.Dispose() }
  $waL = $screen.WorkingArea.Left / $dpiScaleX
  $waT = $screen.WorkingArea.Top / $dpiScaleY
  $waW = $screen.WorkingArea.Width / $dpiScaleX
  $waH = $screen.WorkingArea.Height / $dpiScaleY
  $count = inc-stack
  $offset = ($count - 1) * 128
  $win.Left = $waL + $waW - $win.Width - 20
  $win.Top = $waT + $waH - $win.Height - 10 - $offset
  l "[ps-stack] count=$count offset=$offset dpiScaleX=$dpiScaleX dpiScaleY=$dpiScaleY"

  $timer = New-Object System.Windows.Threading.DispatcherTimer
  $timer.Interval = [TimeSpan]::FromSeconds($timeout)
  $timer.Add_Tick({ $win.Close(); $timer.Stop() })

  $win.Add_Closed({
    $timer.Stop()
    try { [HotkeyHelper]::UnregisterHotKey((New-Object System.Windows.Interop.WindowInteropHelper($win)).Handle, $HOTKEY_DISMISS) } catch {}
    try { [HotkeyHelper]::UnregisterHotKey((New-Object System.Windows.Interop.WindowInteropHelper($win)).Handle, $HOTKEY_FOCUS) } catch {}
    dec-stack
    $frame.Continue = $false
  })

  $timer.Start()
  $win.Show()
  l '[ps-shown]'

  [HotkeyHelper]::Setup($win, { $win.Close() }, { $win.Close(); Focus-PiTerminal $hwndNum $winTitle }, $HOTKEY_DISMISS, $HOTKEY_FOCUS)
  l '[ps-hotkeys-setup]'

  $frame = [System.Windows.Threading.DispatcherFrame]::new($true)
  [System.Windows.Threading.Dispatcher]::PushFrame($frame)
  l '[ps-done]'
}

l '[host-ready]'
Write-Output "READY"

while (($line = [Console]::In.ReadLine()) -ne $null) {
  try {
    $data = $line | ConvertFrom-Json
    Show-Notify $data
    Write-Output "OK"
  } catch {
    l "[host-error] $_"
    Write-Output "ERROR:$_"
  }
}

l '[host-exit]'
