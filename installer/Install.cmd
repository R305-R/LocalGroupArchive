@echo off
setlocal
title LocalGroupArchive Installer
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install-LocalGroupArchive.ps1" -Action Install -PayloadRoot "%~dp0..\plugin"
set "LGA_EXIT=%ERRORLEVEL%"
echo.
if not "%LGA_EXIT%"=="0" (
  echo Installation did not complete. Read the error and log path above.
) else (
  echo Installation complete. Discord was restarted automatically when detected.
)
pause
exit /b %LGA_EXIT%
