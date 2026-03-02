$WshShell = New-Object -ComObject WScript.Shell
$StartMenuPath = [System.IO.Path]::Combine($env:APPDATA, "Microsoft\Windows\Start Menu\Programs")
$DesktopPath = [System.IO.Path]::Combine($env:USERPROFILE, "Desktop")
$ProjectPath = "C:\Users\admin\LeelaV1"
$LauncherPath = "$ProjectPath\launch_leela.vbs"
$IconPath = "$ProjectPath\assets\icon.ico"

# 1. Desktop Shortcut (Silent Launch)
$DesktopShortcutPath = [System.IO.Path]::Combine($DesktopPath, "Leela V1.lnk")
$DesktopShortcut = $WshShell.CreateShortcut($DesktopShortcutPath)
$DesktopShortcut.TargetPath = "wscript.exe"
$DesktopShortcut.Arguments = "`"$LauncherPath`""
$DesktopShortcut.WorkingDirectory = $ProjectPath
$DesktopShortcut.IconLocation = $IconPath
$DesktopShortcut.Save()

# 2. Start Menu Shortcut (Silent Launch)
$StartShortcutPath = [System.IO.Path]::Combine($StartMenuPath, "Leela V1.lnk")
$StartShortcut = $WshShell.CreateShortcut($StartShortcutPath)
$StartShortcut.TargetPath = "wscript.exe"
$StartShortcut.Arguments = "`"$LauncherPath`""
$StartShortcut.WorkingDirectory = $ProjectPath
$StartShortcut.IconLocation = $IconPath
$StartShortcut.Save()

Write-Host "Shortcuts created:"
Write-Host " - Desktop: Leela V1 (Silent Launch)"
Write-Host " - Start Menu: Leela V1 (Silent Launch)"
Write-Host "Icon: $IconPath"
