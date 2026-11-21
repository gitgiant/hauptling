@echo off
rem Hauptling on Windows runs entirely inside WSL; this just hands over to install.sh there.
where wsl.exe >nul 2>nul || (echo WSL is not installed. Run "wsl --install" as administrator, reboot, then rerun. & exit /b 1)
wsl.exe --cd "%~dp0" -- bash ./install.sh %*
exit /b %errorlevel%
