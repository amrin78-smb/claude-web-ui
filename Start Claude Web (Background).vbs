' Claude Code Web UI - silent background launcher (NO admin rights needed).
' Starts the server with a completely hidden window. Close nothing - it keeps
' running until you log off, reboot, or run "Stop Claude Web.bat".
'
' How it works: WScript.Shell.Run with window-style 0 = hidden, and the script
' exits immediately (the False at the end = don't wait), so Node is detached and
' runs on its own with no console window at all.

Dim shell, fso, here
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

' Folder this .vbs lives in (so it works no matter where you launch it from).
here = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = here

' Run Node hidden and detached.
'   0     = hidden window
'   False = return immediately, don't wait for it to finish
shell.Run "cmd /c node server\index.js", 0, False
