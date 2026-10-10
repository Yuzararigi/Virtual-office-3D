@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 goto NONODE
if not exist "node_modules" goto INSTALL
goto RUN
:NONODE
echo Node.js tidak ditemukan.
echo Install dulu dari https://nodejs.org lalu jalankan lagi file ini.
pause
exit /b 1
:INSTALL
echo Menginstall dependensi, mohon tunggu...
call npm install
if errorlevel 1 goto NPMFAIL
goto RUN
:NPMFAIL
echo npm install gagal. Periksa koneksi internet lalu coba lagi.
pause
exit /b 1
:RUN
echo.
echo Kantor Virtual 3D berjalan di http://localhost:8080
echo Bagikan http://IP-KOMPUTER-INI:8080 ke tim yang satu WiFi.
echo Tekan Ctrl+C untuk berhenti.
echo.
node server.js
pause
